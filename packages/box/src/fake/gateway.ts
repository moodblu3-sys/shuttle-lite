import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { ShuttleError, sleep } from '@shuttle-lite/core';
import type {
  AiExtractionRequest,
  AiExtractionResponse,
  BoxFile,
  BoxFolder,
  BoxGateway,
  BoxIdentity,
  BoxItemSummary,
  CommitSessionRequest,
  MetadataTemplateSpec,
  MetadataValues,
  UploadDirectRequest,
  UploadedPart,
  UploadPartRequest,
  UploadSessionInfo,
} from '../gateway';
import { classifyText, isUnsupportedForAi, readTextHead } from './classify';
import { FAKE_ROOT_ID, FakeBoxState, type FakeFile } from './state';

export interface FakeGatewayOptions {
  readonly rootDir: string;
  readonly maxFileBytes: number;
  readonly partSize?: number;
  /** Emulate the representation-pending error on the first AI call per file. */
  readonly aiPendingFirstCall?: boolean;
  /** Return a 429 with Retry-After on every Nth upload call. 0 disables it. */
  readonly rateLimitEvery?: number;
  readonly latencyMs?: number;
  readonly sessionTtlMs?: number;
}

/** One-shot failure injection for demos and recovery tests. */
export type FakeOperation =
  | 'uploadDirect'
  | 'uploadPart'
  | 'commitUploadSession'
  | 'setMetadata'
  | 'extractStructured'
  | 'moveFile'
  | 'getFile'
  | 'deleteTestFile';

const DEFAULT_PART_SIZE = 8 * 1024 * 1024;

function toBoxFile(file: FakeFile): BoxFile {
  return {
    id: file.id,
    etag: createHash('sha1').update(JSON.stringify(file)).digest('hex'),
    name: file.name,
    size: file.size,
    sha1: file.sha1,
    parentFolderId: file.parentId,
    versionId: file.versionId,
    createdAt: file.createdAt,
    modifiedAt: file.modifiedAt,
  };
}

/**
 * Local stand-in for a Box enterprise. It stores content on disk, computes
 * real SHA-1 digests, and reproduces the failure modes the worker has to
 * survive: name conflicts, rate limits, expired upload sessions, unsupported
 * AI input and representations that are not ready yet.
 */
export class FakeBoxGateway implements BoxGateway {
  readonly kind = 'fake' as const;
  readonly #state: FakeBoxState;
  readonly #options: FakeGatewayOptions;
  readonly #pendingFailures = new Map<FakeOperation, ShuttleError[]>();

  constructor(options: FakeGatewayOptions) {
    this.#options = options;
    this.#state = new FakeBoxState(options.rootDir);
  }

  get statePath(): string {
    return this.#state.statePath;
  }

  failNext(operation: FakeOperation, error: ShuttleError): void {
    const queue = this.#pendingFailures.get(operation) ?? [];
    queue.push(error);
    this.#pendingFailures.set(operation, queue);
  }

  #checkInjectedFailure(operation: FakeOperation): void {
    const queue = this.#pendingFailures.get(operation);
    if (!queue || queue.length === 0) return;
    const error = queue.shift();
    if (queue.length === 0) this.#pendingFailures.delete(operation);
    if (error) throw error;
  }

  async #throttle(): Promise<void> {
    if (this.#options.latencyMs && this.#options.latencyMs > 0) {
      await sleep(this.#options.latencyMs);
    }
  }

  #countUploadAttempt(): void {
    const every = this.#options.rateLimitEvery ?? 0;
    const attempts = this.#state.mutate((state) => {
      state.uploadAttempts += 1;
      return state.uploadAttempts;
    });
    if (every > 0 && attempts % every === 0) {
      throw new ShuttleError('BOX_RATE_LIMIT', 'Fake Boxがrate limitを返しました', {
        status: 429,
        retryAfterMs: 1_000,
        requestId: `fake-${attempts}`,
      });
    }
  }

  async whoAmI(): Promise<BoxIdentity> {
    return {
      userId: 'fake-service-account',
      login: 'shuttle-lite@fake.local',
      name: 'Shuttle Lite Fake Service Account',
      enterpriseId: 'fake-enterprise',
    };
  }

  async ensureFolder(parentFolderId: string, name: string): Promise<BoxFolder> {
    return this.#state.mutate((state) => {
      if (!state.folders[parentFolderId]) {
        throw new ShuttleError('BOX_NOT_FOUND', `parent folderが存在しません: ${parentFolderId}`, {
          status: 404,
        });
      }
      const existing = Object.values(state.folders).find(
        (folder) => folder.parentId === parentFolderId && folder.name === name,
      );
      if (existing)
        return { id: existing.id, name: existing.name, parentFolderId: existing.parentId };
      state.nextId += 1;
      const id = `fld${state.nextId}`;
      state.folders[id] = { id, name, parentId: parentFolderId };
      return { id, name, parentFolderId };
    });
  }

  async ensureFolderPath(rootFolderId: string, segments: readonly string[]): Promise<BoxFolder> {
    let current: BoxFolder = (await this.getFolder(rootFolderId)) ?? {
      id: FAKE_ROOT_ID,
      name: 'All Files',
      parentFolderId: null,
    };
    for (const segment of segments) {
      if (segment.trim().length === 0) continue;
      current = await this.ensureFolder(current.id, segment);
    }
    return current;
  }

  async getFolder(folderId: string): Promise<BoxFolder | null> {
    const folder = this.#state.read().folders[folderId];
    return folder ? { id: folder.id, name: folder.name, parentFolderId: folder.parentId } : null;
  }

  async listFolder(folderId: string): Promise<BoxItemSummary[]> {
    const state = this.#state.read();
    const folders: BoxItemSummary[] = Object.values(state.folders)
      .filter((folder) => folder.parentId === folderId)
      .map((folder) => ({ type: 'folder' as const, id: folder.id, name: folder.name }));
    const files: BoxItemSummary[] = Object.values(state.files)
      .filter((file) => file.parentId === folderId)
      .map((file) => ({
        type: 'file' as const,
        id: file.id,
        name: file.name,
        size: file.size,
        sha1: file.sha1,
      }));
    return [...folders, ...files].sort((a, b) => a.name.localeCompare(b.name));
  }

  async findFileByName(folderId: string, name: string): Promise<BoxFile | null> {
    const file = Object.values(this.#state.read().files).find(
      (entry) => entry.parentId === folderId && entry.name === name,
    );
    return file ? toBoxFile(file) : null;
  }

  async preflightUpload(request: {
    parentFolderId: string;
    name: string;
    size: number;
  }): Promise<void> {
    const state = this.#state.read();
    if (!state.folders[request.parentFolderId]) {
      throw new ShuttleError('BOX_NOT_FOUND', `folderが存在しません: ${request.parentFolderId}`, {
        status: 404,
      });
    }
    if (request.size > this.#options.maxFileBytes) {
      throw new ShuttleError(
        'SIZE_LIMIT',
        `file sizeが上限を超えています: ${request.size} > ${this.#options.maxFileBytes}`,
        { status: 409 },
      );
    }
    const conflict = Object.values(state.files).find(
      (file) => file.parentId === request.parentFolderId && file.name === request.name,
    );
    if (conflict) {
      throw new ShuttleError('BOX_CONFLICT', `同名itemが既に存在します: ${request.name}`, {
        status: 409,
        details: { conflictFileId: conflict.id },
      });
    }
  }

  async uploadDirect(request: UploadDirectRequest): Promise<BoxFile> {
    this.#checkInjectedFailure('uploadDirect');
    this.#countUploadAttempt();
    await this.preflightUpload({
      parentFolderId: request.parentFolderId,
      name: request.name,
      size: request.size,
    });
    await this.#throttle();

    const fileId = this.#state.nextId('fil');
    const target = this.#state.objectPath(fileId);
    const hash = createHash('sha1');
    let written = 0;
    await pipeline(
      request.content(),
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          hash.update(chunk);
          written += chunk.byteLength;
          request.onProgress?.(written);
          yield chunk;
        }
      },
      createWriteStream(target),
      request.signal ? { signal: request.signal } : {},
    );
    const sha1 = hash.digest('hex');
    if (sha1 !== request.sha1Hex) {
      rmSync(target, { force: true });
      throw new ShuttleError('INTEGRITY_MISMATCH', 'Fake BoxがSHA-1不一致を検出しました', {
        status: 400,
        details: { expected: request.sha1Hex, actual: sha1 },
      });
    }
    return this.#commitFileEntry({
      fileId,
      parentId: request.parentFolderId,
      name: request.name,
      size: written,
      sha1,
      contentModifiedAt: request.contentModifiedAt ?? null,
    });
  }

  async createUploadSession(request: {
    parentFolderId: string;
    name: string;
    size: number;
  }): Promise<UploadSessionInfo> {
    await this.preflightUpload(request);
    const partSize = this.#options.partSize ?? DEFAULT_PART_SIZE;
    const totalParts = Math.max(1, Math.ceil(request.size / partSize));
    const sessionId = this.#state.nextId('ses');
    const expiresAt = new Date(
      Date.now() + (this.#options.sessionTtlMs ?? 60 * 60_000),
    ).toISOString();
    this.#state.mutate((state) => {
      state.sessions[sessionId] = {
        sessionId,
        parentId: request.parentFolderId,
        name: request.name,
        size: request.size,
        partSize,
        totalParts,
        expiresAt,
        state: 'OPEN',
        parts: {},
      };
    });
    mkdirSync(this.#state.sessionDir(sessionId), { recursive: true });
    return { sessionId, partSize, totalParts, expiresAt };
  }

  async getUploadSession(sessionId: string): Promise<UploadSessionInfo | null> {
    const session = this.#state.read().sessions[sessionId];
    if (!session || session.state !== 'OPEN') return null;
    if (session.expiresAt && Date.parse(session.expiresAt) < Date.now()) return null;
    return {
      sessionId,
      partSize: session.partSize,
      totalParts: session.totalParts,
      expiresAt: session.expiresAt,
    };
  }

  async uploadPart(request: UploadPartRequest): Promise<UploadedPart> {
    this.#checkInjectedFailure('uploadPart');
    this.#countUploadAttempt();
    const session = this.#state.read().sessions[request.sessionId];
    if (!session) {
      throw new ShuttleError(
        'BOX_NOT_FOUND',
        `upload sessionが存在しません: ${request.sessionId}`,
        {
          status: 404,
        },
      );
    }
    if (
      session.state !== 'OPEN' ||
      (session.expiresAt && Date.parse(session.expiresAt) < Date.now())
    ) {
      throw new ShuttleError('UPLOAD_SESSION_EXPIRED', 'upload sessionが利用できません', {
        status: 410,
      });
    }
    await this.#throttle();
    const sha1 = createHash('sha1').update(request.chunk).digest('hex');
    writeFileSync(this.#state.partPath(request.sessionId, request.offset), request.chunk);
    const part: UploadedPart = {
      partId: `P${request.offset}`,
      offset: request.offset,
      size: request.chunk.byteLength,
      sha1,
    };
    this.#state.mutate((state) => {
      const current = state.sessions[request.sessionId];
      if (current) current.parts[String(request.offset)] = { ...part };
    });
    return part;
  }

  async listUploadSessionParts(sessionId: string): Promise<UploadedPart[]> {
    const session = this.#state.read().sessions[sessionId];
    if (!session) return [];
    return Object.values(session.parts).sort((a, b) => a.offset - b.offset);
  }

  async commitUploadSession(request: CommitSessionRequest): Promise<BoxFile> {
    this.#checkInjectedFailure('commitUploadSession');
    const session = this.#state.read().sessions[request.sessionId];
    if (!session) {
      throw new ShuttleError(
        'BOX_NOT_FOUND',
        `upload sessionが存在しません: ${request.sessionId}`,
        {
          status: 404,
        },
      );
    }
    if (session.state === 'COMMITTED') {
      const existing = Object.values(this.#state.read().files).find(
        (file) => file.parentId === session.parentId && file.name === session.name,
      );
      if (existing) return toBoxFile(existing);
    }
    const stored = Object.values(session.parts).sort((a, b) => a.offset - b.offset);
    const expectedParts = request.parts.length > 0 ? request.parts : stored;
    const missing = expectedParts.filter(
      (part) => !stored.some((entry) => entry.offset === part.offset && entry.size === part.size),
    );
    if (missing.length > 0 || stored.length !== session.totalParts) {
      throw new ShuttleError('UPLOAD_PART_MISMATCH', 'Box側のpartが揃っていません', {
        status: 400,
        details: { uploaded: stored.length, totalParts: session.totalParts },
      });
    }

    const fileId = this.#state.nextId('fil');
    const target = this.#state.objectPath(fileId);
    const hash = createHash('sha1');
    let size = 0;
    const out = createWriteStream(target);
    try {
      for (const part of stored) {
        const buffer = readFileSync(this.#state.partPath(request.sessionId, part.offset));
        hash.update(buffer);
        size += buffer.byteLength;
        if (!out.write(buffer)) {
          await new Promise((resolve) => out.once('drain', resolve));
        }
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        out.end((error?: Error | null) => (error ? reject(error) : resolve()));
      });
    }
    const sha1 = hash.digest('hex');
    if (sha1 !== request.sha1Hex) {
      rmSync(target, { force: true });
      throw new ShuttleError('INTEGRITY_MISMATCH', 'Fake BoxがcommitでSHA-1不一致を検出しました', {
        status: 400,
        details: { expected: request.sha1Hex, actual: sha1 },
      });
    }
    const file = this.#commitFileEntry({
      fileId,
      parentId: session.parentId,
      name: session.name,
      size,
      sha1,
      contentModifiedAt: request.contentModifiedAt ?? null,
    });
    this.#state.mutate((state) => {
      const current = state.sessions[request.sessionId];
      if (current) current.state = 'COMMITTED';
    });
    rmSync(this.#state.sessionDir(request.sessionId), { recursive: true, force: true });
    return file;
  }

  async abortUploadSession(sessionId: string): Promise<void> {
    this.#state.mutate((state) => {
      const session = state.sessions[sessionId];
      if (session) session.state = 'ABORTED';
    });
    rmSync(this.#state.sessionDir(sessionId), { recursive: true, force: true });
  }

  async getFile(fileId: string): Promise<BoxFile | null> {
    this.#checkInjectedFailure('getFile');
    const file = this.#state.read().files[fileId];
    return file ? toBoxFile(file) : null;
  }

  async deleteTestFile(fileId: string, etag: string): Promise<void> {
    this.#checkInjectedFailure('deleteTestFile');
    this.#state.mutate((state) => {
      const file = state.files[fileId];
      if (!file)
        throw new ShuttleError('BOX_NOT_FOUND', '削除対象が見つかりません', { status: 404 });
      if (!etag || toBoxFile(file).etag !== etag)
        throw new ShuttleError('APPROVAL_STALE', '削除前にファイルが変更されました', {
          status: 412,
        });
      (state.trash ??= {})[fileId] = file;
      delete state.files[fileId];
    });
  }

  async moveFile(request: {
    fileId: string;
    targetFolderId: string;
    newName?: string;
  }): Promise<BoxFile> {
    this.#checkInjectedFailure('moveFile');
    return this.#state.mutate((state) => {
      const file = state.files[request.fileId];
      if (!file) {
        throw new ShuttleError('BOX_NOT_FOUND', `fileが存在しません: ${request.fileId}`, {
          status: 404,
        });
      }
      if (!state.folders[request.targetFolderId]) {
        throw new ShuttleError('BOX_NOT_FOUND', `folderが存在しません: ${request.targetFolderId}`, {
          status: 404,
        });
      }
      const nextName = request.newName ?? file.name;
      const conflict = Object.values(state.files).find(
        (entry) =>
          entry.id !== file.id &&
          entry.parentId === request.targetFolderId &&
          entry.name === nextName,
      );
      if (conflict) {
        throw new ShuttleError('MOVE_CONFLICT', `移動先に同名itemがあります: ${nextName}`, {
          status: 409,
          details: { conflictFileId: conflict.id },
        });
      }
      file.parentId = request.targetFolderId;
      file.name = nextName;
      file.modifiedAt = new Date().toISOString();
      return toBoxFile(file);
    });
  }

  async setMetadata(fileId: string, values: MetadataValues): Promise<void> {
    this.#checkInjectedFailure('setMetadata');
    this.#state.mutate((state) => {
      const file = state.files[fileId];
      if (!file) {
        throw new ShuttleError('BOX_NOT_FOUND', `fileが存在しません: ${fileId}`, { status: 404 });
      }
      if (file.metadata) {
        throw new ShuttleError('METADATA_CONFLICT', 'metadata instanceが既に存在します', {
          status: 409,
        });
      }
      file.metadata = { ...values };
    });
  }

  async updateMetadata(fileId: string, values: MetadataValues): Promise<void> {
    this.#state.mutate((state) => {
      const file = state.files[fileId];
      if (!file) {
        throw new ShuttleError('BOX_NOT_FOUND', `fileが存在しません: ${fileId}`, { status: 404 });
      }
      file.metadata = { ...(file.metadata ?? {}), ...values };
    });
  }

  async getMetadata(fileId: string): Promise<Record<string, unknown> | null> {
    const file = this.#state.read().files[fileId];
    return file?.metadata ?? null;
  }

  async extractStructured(request: AiExtractionRequest): Promise<AiExtractionResponse> {
    this.#checkInjectedFailure('extractStructured');
    const file = this.#state.read().files[request.fileId];
    if (!file) {
      throw new ShuttleError('BOX_NOT_FOUND', `fileが存在しません: ${request.fileId}`, {
        status: 404,
      });
    }
    if (isUnsupportedForAi(file.name)) {
      throw new ShuttleError('AI_UNSUPPORTED', `Box AIが対象外のfile形式です: ${file.name}`, {
        status: 400,
      });
    }
    const calls = this.#state.mutate((state) => {
      const count = (state.aiCalls[request.fileId] ?? 0) + 1;
      state.aiCalls[request.fileId] = count;
      return count;
    });
    if (this.#options.aiPendingFirstCall && calls === 1) {
      throw new ShuttleError('AI_NOT_READY', 'representationの生成中です', { status: 202 });
    }
    await this.#throttle();
    const text = readTextHead(this.#state.objectPath(file.id));
    const classification = classifyText(text, file.name, request.destinationKeys);
    if (request.destinations?.some((entry) => entry.key.startsWith('DEST_'))) {
      const haystack = `${request.fileName} ${text}`.toLocaleLowerCase();
      const scored = request.destinations
        .map((entry) => ({
          key: entry.key,
          score: entry.label
            .split(/[\s/]+/)
            .filter((word) => word.length >= 2 && haystack.includes(word.toLocaleLowerCase()))
            .length,
        }))
        .filter((entry) => entry.score > 0 && request.destinationKeys.includes(entry.key))
        .sort((a, b) => b.score - a.score);
      const best = scored[0];
      const match = best && best.score !== scored[1]?.score ? best.key : null;
      return {
        provider: 'fake-folder-name-matcher',
        confidence: null,
        references: [],
        fields: {
          ...classification,
          suggestedDestinationKey: match,
          reason: match
            ? 'テスト環境：文書中の語句とフォルダー名が一致しました。'
            : 'テスト環境：配置先を一意に判断できません。手動で選択してください。',
        },
      };
    }
    return {
      provider: 'fake-heuristic',
      fields: {
        documentType: classification.documentType,
        businessDomain: classification.businessDomain,
        businessIdentifier: classification.businessIdentifier,
        effectiveDate: classification.effectiveDate,
        suggestedDestinationKey: classification.suggestedDestinationKey,
        suggestedTags: classification.suggestedTags.join(','),
        reason: classification.reason,
      },
      confidence: classification.confidence,
      references: classification.references,
    };
  }

  async getMetadataTemplate(): Promise<MetadataTemplateSpec | null> {
    return this.#state.read().template;
  }

  async createMetadataTemplate(spec: MetadataTemplateSpec): Promise<void> {
    this.#state.mutate((state) => {
      state.template = spec;
    });
  }

  async close(): Promise<void> {
    // Nothing to release: the fake keeps no sockets open.
  }

  /** Test and demo helper: byte size actually stored for a file. */
  storedSize(fileId: string): number {
    try {
      return statSync(this.#state.objectPath(fileId)).size;
    } catch {
      return -1;
    }
  }

  /** Test and demo helper: read stored content back. */
  readStored(fileId: string): Buffer {
    return readFileSync(this.#state.objectPath(fileId));
  }

  openStored(fileId: string) {
    return createReadStream(this.#state.objectPath(fileId));
  }

  #commitFileEntry(input: {
    fileId: string;
    parentId: string;
    name: string;
    size: number;
    sha1: string;
    contentModifiedAt: string | null;
  }): BoxFile {
    return this.#state.mutate((state) => {
      const at = new Date().toISOString();
      const file: FakeFile = {
        id: input.fileId,
        name: input.name,
        parentId: input.parentId,
        size: input.size,
        sha1: input.sha1,
        versionId: `ver${input.fileId}`,
        createdAt: at,
        modifiedAt: at,
        contentModifiedAt: input.contentModifiedAt,
        metadata: null,
      };
      state.files[input.fileId] = file;
      return toBoxFile(file);
    });
  }
}
