import {
  checkBoxFileName,
  isWindowsReservedName,
  type MigrationItem,
  ShuttleError,
  stagingFileName,
} from '@shuttle-lite/core';
import { buildProvenanceMetadata } from '@shuttle-lite/routing';
import type { UploadedPart } from '@shuttle-lite/box';
import type { JobContext } from '../context';
import { LocalSourceAdapter } from '../source/local';
import { assertSourceUnchanged, sourceRefOf } from './source';

const PROGRESS_INTERVAL_MS = 400;

/** DISCOVERED or HASHING: compute the source digest without buffering the file. */
export async function hashItem(ctx: JobContext, item: MigrationItem): Promise<void> {
  if (item.state === 'DISCOVERED') {
    ctx.store.transitionItem({
      itemId: item.id,
      to: 'HASHING',
      telemetry: ctx.telemetry,
      event: { status: 'STARTED', phase: 'SCAN', sizeBytes: item.sourceSize },
    });
  }
  await assertSourceUnchanged(ctx, item);
  const digest = await ctx.source.digest(sourceRefOf(item));
  if (digest.bytes !== item.sourceSize) {
    throw new ShuttleError('SOURCE_CHANGED', 'Hash中にsource fileのsizeが変わりました', {
      details: { expected: item.sourceSize, actual: digest.bytes },
    });
  }
  ctx.store.transitionItem({
    itemId: item.id,
    to: 'PREFLIGHT',
    telemetry: ctx.telemetry,
    patch: { sourceSha1: digest.sha1 },
    event: { status: 'SUCCEEDED', phase: 'SCAN', sizeBytes: digest.bytes },
  });
}

/**
 * PREFLIGHT: everything that must be true before a byte is sent. A name
 * conflict in staging is either the recovery of our own earlier upload, or a
 * review item. It is never an overwrite (acceptance criterion 6).
 */
export async function preflightItem(ctx: JobContext, item: MigrationItem): Promise<void> {
  await assertSourceUnchanged(ctx, item);
  if (!item.sourceSha1) {
    throw new ShuttleError('STATE_INVALID', 'SHA-1未計算のままpreflightに進んでいます');
  }

  // A path that is too long for Windows is caught here rather than part way
  // through an upload.
  if (ctx.source instanceof LocalSourceAdapter) {
    ctx.source.checkPathLength(item.sourceAbsolutePath);
  }
  const nameCheck = checkBoxFileName(item.sourceFileName);
  if (!nameCheck.valid) {
    throw new ShuttleError('NAME_INVALID', `Boxで利用できないfile名です: ${nameCheck.reason}`, {
      details: { fileName: item.sourceFileName },
    });
  }
  if (isWindowsReservedName(item.sourceFileName)) {
    throw new ShuttleError(
      'NAME_INVALID',
      `Windowsの予約名です。移行先で扱えないためreviewで判断してください: ${item.sourceFileName}`,
      { details: { fileName: item.sourceFileName } },
    );
  }
  if (item.sourceSize > ctx.config.limits.maxFileBytes) {
    throw new ShuttleError(
      'SIZE_LIMIT',
      `file sizeがaccount上限を超えています: ${item.sourceSize} bytes`,
    );
  }

  const stagingName = item.stagingName ?? stagingFileName(item.id, item.sourceFileName);
  const adopted = await adoptStagedCopy(ctx, item, stagingName);
  if (adopted) return;

  await ctx.gateway.preflightUpload({
    parentFolderId: ctx.stagingFolderId,
    name: stagingName,
    size: item.sourceSize,
  });

  ctx.store.transitionItem({
    itemId: item.id,
    to: 'READY',
    telemetry: ctx.telemetry,
    patch: { stagingName, uploadStrategy: strategyFor(ctx, item.sourceSize) },
    event: { status: 'SUCCEEDED', phase: 'PREFLIGHT', sizeBytes: item.sourceSize },
  });
}

/**
 * Deterministic staging names make our own earlier upload recognisable. If the
 * content matches, adopt it instead of sending the bytes again; if it differs,
 * refuse to overwrite and let a human decide.
 *
 * Used both in preflight and when an upload itself comes back with 409, which
 * happens when a request whose outcome was unknown had actually landed.
 */
async function adoptStagedCopy(
  ctx: JobContext,
  item: MigrationItem,
  stagingName: string,
): Promise<boolean> {
  const existing = await ctx.gateway.findFileByName(ctx.stagingFolderId, stagingName);
  if (!existing) return false;

  if (existing.sha1 !== item.sourceSha1 || existing.size !== item.sourceSize) {
    throw new ShuttleError(
      'BOX_CONFLICT',
      `staging folderに内容の異なる同名itemがあります: ${stagingName}`,
      { details: { conflictFileId: existing.id } },
    );
  }

  ctx.logger.info('staging上に一致するfileを発見したのでuploadをskipします', {
    itemId: item.id,
    boxFileId: existing.id,
  });

  // READY と UPLOADING を通ってから STAGED へ入れる。state machineが
  // 許す順序を保つため、途中のstateも記録する。
  const current = ctx.store.getItem(item.id);
  if (current?.state === 'PREFLIGHT') {
    ctx.store.transitionItem({
      itemId: item.id,
      to: 'READY',
      telemetry: ctx.telemetry,
      patch: { stagingName, uploadStrategy: strategyFor(ctx, item.sourceSize) },
    });
  }
  if (ctx.store.getItem(item.id)?.state === 'READY') {
    ctx.store.transitionItem({
      itemId: item.id,
      to: 'UPLOADING',
      telemetry: ctx.telemetry,
      patch: { bytesTransferred: existing.size },
    });
  }
  ctx.store.transitionItem({
    itemId: item.id,
    to: 'STAGED',
    telemetry: ctx.telemetry,
    patch: {
      stagingName,
      boxFileId: existing.id,
      boxFileVersionId: existing.versionId,
      boxSize: existing.size,
      boxSha1: existing.sha1,
      bytesTransferred: existing.size,
    },
    event: {
      status: 'SUCCEEDED',
      phase: 'UPLOAD',
      boxFileId: existing.id,
      sizeBytes: existing.size,
      message: '既存のstaging fileを照合して再利用しました',
    },
  });
  return true;
}

function strategyFor(ctx: JobContext, size: number): 'DIRECT' | 'CHUNKED' {
  return size > ctx.config.limits.directUploadMaxBytes ? 'CHUNKED' : 'DIRECT';
}

/** READY or UPLOADING: send the bytes, then record the Box identity. */
export async function uploadItem(ctx: JobContext, item: MigrationItem): Promise<void> {
  const stagingName = item.stagingName ?? stagingFileName(item.id, item.sourceFileName);
  const strategy = item.uploadStrategy ?? strategyFor(ctx, item.sourceSize);
  if (item.state === 'READY') {
    ctx.store.transitionItem({
      itemId: item.id,
      to: 'UPLOADING',
      telemetry: ctx.telemetry,
      patch: { stagingName, uploadStrategy: strategy, attempts: item.attempts + 1 },
      event: { status: 'STARTED', phase: 'UPLOAD', sizeBytes: item.sourceSize },
    });
  }
  await assertSourceUnchanged(ctx, item);
  if (!item.sourceSha1) {
    throw new ShuttleError('STATE_INVALID', 'SHA-1未計算のままuploadに進んでいます');
  }

  const started = Date.now();
  let file;
  try {
    file =
      strategy === 'CHUNKED'
        ? await uploadChunked(ctx, item, stagingName)
        : await uploadDirect(ctx, item, stagingName);
  } catch (error) {
    // 409 here means a request whose outcome we never recorded had actually
    // landed. Real Box returned this after an HTTP/2 stream error was retried.
    // Adopting our own copy is what keeps the retry from creating a duplicate.
    if ((error as { category?: string }).category !== 'BOX_CONFLICT') throw error;
    ctx.logger.warn('upload中に409を受けたのでstaging上のfileと照合します', {
      itemId: item.id,
      stagingName,
    });
    if (await adoptStagedCopy(ctx, item, stagingName)) return;
    throw error;
  }

  ctx.store.transitionItem({
    itemId: item.id,
    to: 'STAGED',
    telemetry: ctx.telemetry,
    patch: {
      boxFileId: file.id,
      boxFileVersionId: file.versionId,
      boxSize: file.size,
      boxSha1: file.sha1,
      bytesTransferred: file.size,
    },
    event: {
      status: 'SUCCEEDED',
      phase: 'UPLOAD',
      boxFileId: file.id,
      sizeBytes: file.size,
      durationMs: Date.now() - started,
    },
  });
}

async function uploadDirect(ctx: JobContext, item: MigrationItem, stagingName: string) {
  let lastReport = 0;
  return ctx.gateway.uploadDirect({
    parentFolderId: ctx.stagingFolderId,
    name: stagingName,
    size: item.sourceSize,
    sha1Hex: item.sourceSha1 ?? '',
    contentModifiedAt: item.sourceModifiedAt,
    content: () => ctx.source.openStream(sourceRefOf(item)),
    onProgress: (bytes) => {
      const now = Date.now();
      if (now - lastReport < PROGRESS_INTERVAL_MS) return;
      lastReport = now;
      ctx.store.updateItem(item.id, { bytesTransferred: bytes });
    },
  });
}

/**
 * Chunked upload with recovery. The Box side part list is the source of truth
 * for what already arrived, so a restart re-sends only the missing parts
 * (docs/requirements.md 4.6, acceptance criterion 5).
 */
async function uploadChunked(ctx: JobContext, item: MigrationItem, stagingName: string) {
  let session = ctx.store.getOpenSession(item.id);
  // A session recorded locally is only usable if Box still has it.
  const remote = session ? await ctx.gateway.getUploadSession(session.boxSessionId) : null;

  if (session && !remote) {
    ctx.logger.warn('Box側のupload sessionが失効していたので作り直します', {
      itemId: item.id,
      sessionId: session.boxSessionId,
    });
    ctx.store.setSessionState(session.id, 'EXPIRED');
    session = null;
  }

  if (!session) {
    const created = await ctx.gateway.createUploadSession({
      parentFolderId: ctx.stagingFolderId,
      name: stagingName,
      size: item.sourceSize,
    });
    const parts = [];
    for (let index = 0; index < created.totalParts; index += 1) {
      const offset = index * created.partSize;
      parts.push({
        index,
        offset,
        size: Math.min(created.partSize, item.sourceSize - offset),
      });
    }
    session = ctx.store.createUploadSession({
      itemId: item.id,
      boxSessionId: created.sessionId,
      partSize: created.partSize,
      totalParts: created.totalParts,
      expiresAt: created.expiresAt,
      parts,
    });
  }

  const activeSession = session;
  const alreadyUploaded = await ctx.gateway.listUploadSessionParts(activeSession.boxSessionId);
  const uploadedByOffset = new Map(alreadyUploaded.map((part) => [part.offset, part]));
  for (const part of alreadyUploaded) {
    ctx.store.markPartUploaded({
      sessionId: activeSession.id,
      partIndex: Math.floor(part.offset / activeSession.partSize),
      sha1: part.sha1,
      boxPartJson: JSON.stringify(part),
    });
  }

  const pending = ctx.store
    .listParts(activeSession.id)
    .filter((part) => !uploadedByOffset.has(part.offset));
  let transferred = alreadyUploaded.reduce((sum, part) => sum + part.size, 0);
  ctx.store.updateItem(item.id, { bytesTransferred: transferred });

  const ref = sourceRefOf(item);
  await Promise.all(
    pending.map((part) =>
      // Part parallelism draws from the same budget as file parallelism.
      ctx.chunkGate.withPermit(async () => {
        const buffer = await ctx.source.readRange(ref, part.offset, part.size);
        const uploaded = await ctx.gateway.uploadPart({
          sessionId: activeSession.boxSessionId,
          offset: part.offset,
          totalSize: item.sourceSize,
          chunk: buffer,
        });
        ctx.store.markPartUploaded({
          sessionId: activeSession.id,
          partIndex: part.partIndex,
          sha1: uploaded.sha1,
          boxPartJson: JSON.stringify(uploaded),
        });
        transferred += uploaded.size;
        ctx.store.updateItem(item.id, { bytesTransferred: transferred });
      }),
    ),
  );

  const parts: UploadedPart[] = ctx.store
    .listParts(activeSession.id)
    .map((part) => (part.boxPartId ? (JSON.parse(part.boxPartId) as UploadedPart) : null))
    .filter((part): part is UploadedPart => part !== null);

  ctx.store.setSessionState(activeSession.id, 'COMMITTING');
  ctx.store.incrementCommitAttempts(activeSession.id);
  const file = await ctx.gateway.commitUploadSession({
    sessionId: activeSession.boxSessionId,
    parts,
    sha1Hex: item.sourceSha1 ?? '',
    contentModifiedAt: item.sourceModifiedAt,
  });
  ctx.store.setSessionState(activeSession.id, 'COMMITTED');
  return file;
}

/**
 * STAGED: nothing is treated as transferred until Box reports the same size
 * and SHA-1 as the source, and the source has not changed meanwhile.
 */
export async function verifyTransfer(ctx: JobContext, item: MigrationItem): Promise<void> {
  if (!item.boxFileId) {
    throw new ShuttleError('STATE_INVALID', 'Box file IDがないままverifyに進んでいます');
  }
  const file = await ctx.gateway.getFile(item.boxFileId);
  if (!file) {
    throw new ShuttleError('BOX_NOT_FOUND', `Box上にfileが見つかりません: ${item.boxFileId}`);
  }
  await assertSourceUnchanged(ctx, item);
  if (file.size !== item.sourceSize || file.sha1 !== item.sourceSha1) {
    throw new ShuttleError('INTEGRITY_MISMATCH', 'Box上のsizeまたはSHA-1がsourceと一致しません', {
      details: {
        sourceSize: item.sourceSize,
        boxSize: file.size,
        sourceSha1: item.sourceSha1,
        boxSha1: file.sha1,
      },
    });
  }
  ctx.store.transitionItem({
    itemId: item.id,
    to: 'TRANSFER_VERIFIED',
    telemetry: ctx.telemetry,
    patch: {
      boxSize: file.size,
      boxSha1: file.sha1,
      boxFileVersionId: file.versionId,
      transferVerifiedAt: new Date().toISOString(),
    },
    event: {
      status: 'SUCCEEDED',
      phase: 'TRANSFER_VERIFY',
      boxFileId: file.id,
      sizeBytes: file.size,
    },
  });
}

/**
 * TRANSFER_VERIFIED and PROVENANCE_PENDING: write provenance metadata. A
 * metadata failure must never re-upload the file (acceptance criterion 7), so
 * this step only ever touches the metadata instance.
 */
export async function applyProvenance(ctx: JobContext, item: MigrationItem): Promise<void> {
  if (item.state === 'TRANSFER_VERIFIED') {
    ctx.store.transitionItem({
      itemId: item.id,
      to: 'PROVENANCE_PENDING',
      telemetry: ctx.telemetry,
      event: { status: 'STARTED', phase: 'METADATA' },
    });
  }
  if (!item.boxFileId || !item.sourceSha1) {
    throw new ShuttleError('STATE_INVALID', 'metadata適用に必要な情報が不足しています');
  }
  const values = buildProvenanceMetadata({
    migrationJobId: item.jobId,
    migrationItemId: item.id,
    sourceRelativePath: item.sourceRelativePath,
    sourceFileName: item.sourceFileName,
    sourceModifiedAt: item.sourceModifiedAt,
    sourceSize: item.sourceSize,
    sourceSha1: item.sourceSha1,
    migratedAt: new Date().toISOString(),
    migrationStatus: 'VERIFIED',
  });

  try {
    await ctx.gateway.setMetadata(item.boxFileId, values);
  } catch (error) {
    const category = (error as { category?: string }).category;
    if (category !== 'METADATA_CONFLICT') throw error;
    // An instance already exists. Adopt it when it belongs to this item,
    // otherwise correct it, but never re-send the file body.
    const existing = await ctx.gateway.getMetadata(item.boxFileId);
    const sameItem =
      existing?.migrationItemId === item.id && existing?.migrationJobId === item.jobId;
    if (!sameItem) {
      ctx.logger.warn('別itemのmetadata instanceを検出したので上書きします', {
        itemId: item.id,
        boxFileId: item.boxFileId,
      });
    }
    await ctx.gateway.updateMetadata(item.boxFileId, values);
  }

  ctx.store.transitionItem({
    itemId: item.id,
    to: 'PROVENANCE_APPLIED',
    telemetry: ctx.telemetry,
    patch: { provenanceAppliedAt: new Date().toISOString() },
    event: { status: 'SUCCEEDED', phase: 'METADATA', boxFileId: item.boxFileId },
  });
}
