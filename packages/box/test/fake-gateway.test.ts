import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha1Buffer, ShuttleError } from '@shuttle-lite/core';
import { FakeBoxGateway } from '@shuttle-lite/box';

const MB = 1024 * 1024;

describe('fake Box gateway', () => {
  let dir: string;
  let sourceDir: string;
  let gateway: FakeBoxGateway;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shuttle-fake-'));
    sourceDir = mkdtempSync(join(tmpdir(), 'shuttle-src-'));
    gateway = new FakeBoxGateway({
      rootDir: join(dir, 'fake-box'),
      maxFileBytes: 100 * MB,
      partSize: 2 * MB,
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(sourceDir, { recursive: true, force: true });
  });

  function writeSource(
    name: string,
    content: Buffer | string,
  ): { path: string; sha1: string; size: number } {
    const path = join(sourceDir, name);
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    writeFileSync(path, buffer);
    return { path, sha1: sha1Buffer(buffer), size: buffer.byteLength };
  }

  it('creates folders idempotently', async () => {
    const first = await gateway.ensureFolderPath('0', ['Shuttle Lite', '_staging']);
    const second = await gateway.ensureFolderPath('0', ['Shuttle Lite', '_staging']);
    expect(second.id).toBe(first.id);
  });

  it('stores content and reports the real SHA-1 and size', async () => {
    const folder = await gateway.ensureFolder('0', 'staging');
    const source = writeSource('msa.txt', '契約書 contract 甲と乙');
    const file = await gateway.uploadDirect({
      parentFolderId: folder.id,
      name: 'msa.txt',
      size: source.size,
      sha1Hex: source.sha1,
      content: () => createReadStream(source.path),
    });
    expect(file.sha1).toBe(source.sha1);
    expect(file.size).toBe(source.size);
    expect(gateway.storedSize(file.id)).toBe(source.size);
    expect((await gateway.getFile(file.id))?.parentFolderId).toBe(folder.id);
  });

  it('rejects a digest mismatch instead of storing a corrupted file', async () => {
    const folder = await gateway.ensureFolder('0', 'staging');
    const source = writeSource('bad.txt', 'hello');
    await expect(
      gateway.uploadDirect({
        parentFolderId: folder.id,
        name: 'bad.txt',
        size: source.size,
        sha1Hex: sha1Buffer(Buffer.from('different')),
        content: () => createReadStream(source.path),
      }),
    ).rejects.toMatchObject({ category: 'INTEGRITY_MISMATCH' });
    expect(await gateway.findFileByName(folder.id, 'bad.txt')).toBeNull();
  });

  it('refuses to overwrite an existing name', async () => {
    const folder = await gateway.ensureFolder('0', 'staging');
    const source = writeSource('dup.txt', 'first');
    await gateway.uploadDirect({
      parentFolderId: folder.id,
      name: 'dup.txt',
      size: source.size,
      sha1Hex: source.sha1,
      content: () => createReadStream(source.path),
    });
    await expect(
      gateway.uploadDirect({
        parentFolderId: folder.id,
        name: 'dup.txt',
        size: source.size,
        sha1Hex: source.sha1,
        content: () => createReadStream(source.path),
      }),
    ).rejects.toMatchObject({ category: 'BOX_CONFLICT' });
  });

  it('completes a chunked upload and can list the parts it already has', async () => {
    const folder = await gateway.ensureFolder('0', 'staging');
    const buffer = Buffer.alloc(5 * MB, 7);
    const source = writeSource('big.bin', buffer);
    const session = await gateway.createUploadSession({
      parentFolderId: folder.id,
      name: 'big.bin',
      size: source.size,
    });
    expect(session.totalParts).toBe(3);

    // Upload two of three parts, as if the process died mid-transfer.
    for (const index of [0, 1]) {
      const offset = index * session.partSize;
      await gateway.uploadPart({
        sessionId: session.sessionId,
        offset,
        totalSize: source.size,
        chunk: buffer.subarray(offset, offset + session.partSize),
      });
    }
    expect(await gateway.listUploadSessionParts(session.sessionId)).toHaveLength(2);
    await expect(
      gateway.commitUploadSession({
        sessionId: session.sessionId,
        parts: [],
        sha1Hex: source.sha1,
      }),
    ).rejects.toMatchObject({ category: 'UPLOAD_PART_MISMATCH' });

    const offset = 2 * session.partSize;
    await gateway.uploadPart({
      sessionId: session.sessionId,
      offset,
      totalSize: source.size,
      chunk: buffer.subarray(offset),
    });
    const parts = await gateway.listUploadSessionParts(session.sessionId);
    const file = await gateway.commitUploadSession({
      sessionId: session.sessionId,
      parts,
      sha1Hex: source.sha1,
    });
    expect(file.size).toBe(source.size);
    expect(file.sha1).toBe(source.sha1);
  });

  it('reports an expired session instead of silently starting over', async () => {
    const expiring = new FakeBoxGateway({
      rootDir: join(dir, 'expiring'),
      maxFileBytes: 100 * MB,
      partSize: 2 * MB,
      sessionTtlMs: -1,
    });
    const folder = await expiring.ensureFolder('0', 'staging');
    const session = await expiring.createUploadSession({
      parentFolderId: folder.id,
      name: 'x.bin',
      size: 4 * MB,
    });
    expect(await expiring.getUploadSession(session.sessionId)).toBeNull();
    await expect(
      expiring.uploadPart({
        sessionId: session.sessionId,
        offset: 0,
        totalSize: 4 * MB,
        chunk: Buffer.alloc(2 * MB),
      }),
    ).rejects.toMatchObject({ category: 'UPLOAD_SESSION_EXPIRED' });
  });

  it('returns a 429 with Retry-After on the configured cadence', async () => {
    const limited = new FakeBoxGateway({
      rootDir: join(dir, 'limited'),
      maxFileBytes: 100 * MB,
      rateLimitEvery: 2,
    });
    const folder = await limited.ensureFolder('0', 'staging');
    const source = writeSource('a.txt', 'one');
    const upload = (name: string) =>
      limited.uploadDirect({
        parentFolderId: folder.id,
        name,
        size: source.size,
        sha1Hex: source.sha1,
        content: () => createReadStream(source.path),
      });
    await upload('a.txt');
    await expect(upload('b.txt')).rejects.toMatchObject({
      category: 'BOX_RATE_LIMIT',
      retryAfterMs: 1_000,
      status: 429,
    });
  });

  it('writes provenance metadata once and reports a conflict on a second create', async () => {
    const folder = await gateway.ensureFolder('0', 'staging');
    const source = writeSource('m.txt', 'invoice 請求書');
    const file = await gateway.uploadDirect({
      parentFolderId: folder.id,
      name: 'm.txt',
      size: source.size,
      sha1Hex: source.sha1,
      content: () => createReadStream(source.path),
    });
    await gateway.setMetadata(file.id, { migrationJobId: 'job_1' });
    await expect(gateway.setMetadata(file.id, { migrationJobId: 'job_1' })).rejects.toMatchObject({
      category: 'METADATA_CONFLICT',
    });
    await gateway.updateMetadata(file.id, { migrationStatus: 'COMPLETED' });
    expect(await gateway.getMetadata(file.id)).toEqual({
      migrationJobId: 'job_1',
      migrationStatus: 'COMPLETED',
    });
  });

  it('suggests only destinations from the allowlist and abstains when unsure', async () => {
    const folder = await gateway.ensureFolder('0', 'staging');
    const keys = ['LEGAL_CONTRACTS', 'FINANCE_INVOICES', 'NEEDS_REVIEW'];

    const contract = writeSource(
      'contract.txt',
      '業務委託契約書\n契約番号: LEG-2026-0042\n発効日 2026-04-01\n甲および乙は',
    );
    const contractFile = await gateway.uploadDirect({
      parentFolderId: folder.id,
      name: 'contract.txt',
      size: contract.size,
      sha1Hex: contract.sha1,
      content: () => createReadStream(contract.path),
    });
    const result = await gateway.extractStructured({
      fileId: contractFile.id,
      destinationKeys: keys,
      fileName: 'contract.txt',
    });
    expect(result.fields.suggestedDestinationKey).toBe('LEGAL_CONTRACTS');
    expect(result.fields.businessIdentifier).toBe('LEG-2026-0042');
    expect(result.fields.effectiveDate).toBe('2026-04-01');
    expect(result.confidence).not.toBeNull();

    const vague = writeSource('notes.txt', 'メモ 会議の記録');
    const vagueFile = await gateway.uploadDirect({
      parentFolderId: folder.id,
      name: 'notes.txt',
      size: vague.size,
      sha1Hex: vague.sha1,
      content: () => createReadStream(vague.path),
    });
    const vagueResult = await gateway.extractStructured({
      fileId: vagueFile.id,
      destinationKeys: keys,
      fileName: 'notes.txt',
    });
    expect(vagueResult.fields.suggestedDestinationKey).toBeNull();
    expect(vagueResult.confidence).toBeNull();
  });

  it('classifies unsupported formats as an AI fallback rather than a failure to retry forever', async () => {
    const folder = await gateway.ensureFolder('0', 'staging');
    const source = writeSource('archive.zip', Buffer.alloc(16, 1));
    const file = await gateway.uploadDirect({
      parentFolderId: folder.id,
      name: 'archive.zip',
      size: source.size,
      sha1Hex: source.sha1,
      content: () => createReadStream(source.path),
    });
    await expect(
      gateway.extractStructured({
        fileId: file.id,
        destinationKeys: ['LEGAL_CONTRACTS'],
        fileName: 'archive.zip',
      }),
    ).rejects.toMatchObject({ category: 'AI_UNSUPPORTED' });
  });

  it('emulates a representation that is not ready on the first call', async () => {
    const pending = new FakeBoxGateway({
      rootDir: join(dir, 'pending'),
      maxFileBytes: 100 * MB,
      aiPendingFirstCall: true,
    });
    const folder = await pending.ensureFolder('0', 'staging');
    const source = writeSource('inv.txt', '請求書 invoice 支払期限 2026-05-31');
    const file = await pending.uploadDirect({
      parentFolderId: folder.id,
      name: 'inv.txt',
      size: source.size,
      sha1Hex: source.sha1,
      content: () => createReadStream(source.path),
    });
    await expect(
      pending.extractStructured({
        fileId: file.id,
        destinationKeys: ['FINANCE_INVOICES'],
        fileName: 'inv.txt',
      }),
    ).rejects.toMatchObject({ category: 'AI_NOT_READY' });
    const second = await pending.extractStructured({
      fileId: file.id,
      destinationKeys: ['FINANCE_INVOICES'],
      fileName: 'inv.txt',
    });
    expect(second.fields.suggestedDestinationKey).toBe('FINANCE_INVOICES');
  });

  it('keeps the Box file ID across a move and refuses to overwrite on conflict', async () => {
    const staging = await gateway.ensureFolder('0', 'staging');
    const final = await gateway.ensureFolder('0', 'final');
    const source = writeSource('report.txt', 'runbook 手順');
    const uploaded = await gateway.uploadDirect({
      parentFolderId: staging.id,
      name: 'it_0001__report.txt',
      size: source.size,
      sha1Hex: source.sha1,
      content: () => createReadStream(source.path),
    });
    const blocker = writeSource('blocker.txt', 'other');
    await gateway.uploadDirect({
      parentFolderId: final.id,
      name: 'report.txt',
      size: blocker.size,
      sha1Hex: blocker.sha1,
      content: () => createReadStream(blocker.path),
    });
    await expect(
      gateway.moveFile({ fileId: uploaded.id, targetFolderId: final.id, newName: 'report.txt' }),
    ).rejects.toMatchObject({ category: 'MOVE_CONFLICT' });

    const moved = await gateway.moveFile({
      fileId: uploaded.id,
      targetFolderId: final.id,
      newName: 'report-2.txt',
    });
    expect(moved.id).toBe(uploaded.id);
    expect(moved.sha1).toBe(source.sha1);
    expect(moved.parentFolderId).toBe(final.id);
  });

  it('can inject a one-shot failure for recovery drills', async () => {
    const folder = await gateway.ensureFolder('0', 'staging');
    const source = writeSource('inject.txt', 'x');
    gateway.failNext(
      'uploadDirect',
      new ShuttleError('BOX_SERVER', 'injected 503', { status: 503 }),
    );
    const upload = () =>
      gateway.uploadDirect({
        parentFolderId: folder.id,
        name: 'inject.txt',
        size: source.size,
        sha1Hex: source.sha1,
        content: () => createReadStream(source.path),
      });
    await expect(upload()).rejects.toMatchObject({ category: 'BOX_SERVER' });
    await expect(upload()).resolves.toMatchObject({ name: 'inject.txt' });
  });
});
