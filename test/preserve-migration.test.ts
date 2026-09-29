import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectJobDestinations } from '@shuttle-lite/box';
import { ShuttleError, type ConflictPolicy } from '@shuttle-lite/core';
import { buildJobSnapshot, buildReportDocument } from '@shuttle-lite/telemetry';
import { processCommands } from '../apps/worker/src/commands';
import { advanceItem, TRANSFER_SCOPE } from '../apps/worker/src/pipeline';
import { sourceRefOf } from '../apps/worker/src/steps/source';
import { prepareFolderTree } from '../apps/worker/src/folder-tree';
import { createHarness, runUntilIdle, type Harness } from './harness';

describe('そのまま移行', () => {
  let h: Harness;
  let target: string;
  beforeEach(async () => {
    h = await createHarness({ directUploadMaxBytes: 64, partSize: 32 });
    target = (await h.gateway.ensureFolder('0', '移行先')).id;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    h.cleanup();
  });

  async function job(
    conflictPolicy: ConflictPolicy = 'RENAME',
    testMode = false,
    transferMode: 'FINAL' | 'STAGED' = 'FINAL',
  ) {
    const profile = h.createProfile({ conflictPolicy });
    const job = h.store.createJob({
      profileId: profile.id,
      operatorLabel: '担当者',
      migrationMode: 'AS_IS',
      testMode,
      transferMode,
    });
    h.store.saveJobDestinations(
      job.id,
      await collectJobDestinations(h.gateway, target, 'fake', [], false),
    );
    h.store.saveJobMetadata(job.id, []);
    h.store.enqueueCommand(job.id, 'START_JOB');
    return job;
  }

  it('preserves the root, nested and empty folders, verifies direct/chunked files without AI, metadata or individual approval', async () => {
    h.writeSource('契約書/A社.txt', '契約書');
    h.writeSource('営業/提案資料.txt', '提案'.repeat(60));
    mkdirSync(join(h.sourceRoot, '空/空の下'), { recursive: true });
    mkdirSync(join(h.sourceRoot, '.対象外'));
    symlinkSync(join(h.sourceRoot, '営業'), join(h.sourceRoot, 'リンク'));
    const move = vi.spyOn(h.gateway, 'moveFile');
    const upload = vi.spyOn(h.gateway, 'uploadDirect');
    const chunked = vi.spyOn(h.gateway, 'createUploadSession');
    const ai = vi.spyOn(h.gateway, 'extractStructured');
    const template = vi.spyOn(h.gateway, 'extractTemplate');
    const metadata = vi.spyOn(h.gateway, 'updateMetadata');
    const j = await job();
    await runUntilIdle(h);
    expect(h.store.getJob(j.id)?.state).toBe('COMPLETED');
    const items = h.store.listItems(j.id);
    expect(items).toHaveLength(2);
    expect(new Set(items.map((i) => i.uploadStrategy))).toEqual(new Set(['DIRECT', 'CHUNKED']));
    const folders = h.store.listMigrationFolders(j.id);
    expect(folders.map((f) => f.relativePath).sort()).toEqual(
      ['', '営業', '契約書', '空', '空/空の下'].sort(),
    );
    for (const f of folders)
      expect(await h.gateway.getFolder(f.boxFolderId!)).toMatchObject({ name: f.name });
    expect(
      await h.gateway.getFolder(folders.find((f) => f.relativePath === '')!.boxFolderId!),
    ).toMatchObject({ parentFolderId: target, name: 'source' });
    for (const i of items) {
      expect(i).toMatchObject({
        state: 'COMPLETED',
        lastErrorCategory: null,
        provenanceAppliedAt: null,
      });
      expect(h.store.getRouting(i.id)).toBeNull();
      expect(await h.gateway.getFile(i.boxFileId!)).toMatchObject({
        parentFolderId: i.finalFolderId,
        name: i.sourceFileName,
        sha1: i.sourceSha1,
        size: i.sourceSize,
      });
      expect(h.store.hasUploadRecord(j.id, i.id, i.boxFileId!)).toBe(true);
    }
    expect(move).not.toHaveBeenCalled();
    expect(h.store.getJob(j.id)).toMatchObject({ transferMode: 'FINAL', stagingFolderId: null });
    for (const call of [...upload.mock.calls, ...chunked.mock.calls]) {
      const request = call[0];
      expect(
        items.some(
          (i) => i.finalFolderId === request.parentFolderId && i.finalName === request.name,
        ),
      ).toBe(true);
    }
    expect(ai).not.toHaveBeenCalled();
    expect(template).not.toHaveBeenCalled();
    expect(metadata).not.toHaveBeenCalled();
    const view = buildJobSnapshot(h.store, j.id)!;
    expect(view.reviewBacklog).toBe(0);
    expect(
      view.phases.some((p) => ['REVIEW', 'METADATA', 'AI_EXTRACTION', 'MOVE'].includes(p.phase)),
    ).toBe(false);
    const report = buildReportDocument(h.store, j.id);
    expect(report.migrationMode).toBe('AS_IS');
    expect(report.folders).toEqual(folders);
    expect(report.rows.every((row) => row.metadataStatus === 'NOT_APPLICABLE')).toBe(true);
  });

  it.each(['RENAME', 'SKIP'] as const)(
    'reuses folders and applies %s to file collisions without overwrite',
    async (policy) => {
      h.writeSource('契約書/契約書.txt', '契約書');
      const first = await job();
      await runUntilIdle(h);
      const original = h.store.listItems(first.id)[0]!;
      const before = await h.gateway.getFile(original.boxFileId!);
      const second = await job(policy);
      await runUntilIdle(h);
      const item = h.store.listItems(second.id)[0]!;
      expect(item.state).toBe(policy === 'RENAME' ? 'COMPLETED' : 'SKIPPED');
      if (policy === 'RENAME') expect(item.finalName).toBe('契約書 (2).txt');
      expect(await h.gateway.getFile(original.boxFileId!)).toEqual(before);
      expect(h.store.listMigrationFolders(second.id).map((f) => f.boxFolderId)).toEqual(
        h.store.listMigrationFolders(first.id).map((f) => f.boxFolderId),
      );
    },
  );

  it('finishes an empty folder tree and retains folder IDs across pause and a fresh runtime', async () => {
    mkdirSync(join(h.sourceRoot, '空'), { recursive: true });
    const j = await job();
    await processCommands(h.ctx);
    await h.newRuntime().tick(); // scan
    const ctx = await h.jobContext(j.id);
    let checks = 0;
    expect(await prepareFolderTree(ctx, () => ++checks > 1)).toBe(false);
    const rootId = h.store.listMigrationFolders(j.id)[0]!.boxFolderId;
    expect(rootId).not.toBeNull();
    h.store.enqueueCommand(j.id, 'PAUSE_JOB');
    await processCommands(h.ctx);
    await h.newRuntime().tick();
    expect(h.store.getJob(j.id)?.state).toBe('PAUSED');
    h.store.enqueueCommand(j.id, 'RESUME_JOB');
    await runUntilIdle(h);
    expect(h.store.getJob(j.id)?.state).toBe('COMPLETED');
    expect(h.store.listMigrationFolders(j.id)[0]?.boxFolderId).toBe(rootId);
    expect((await h.gateway.listFolder(rootId!)).map((f) => f.name)).toEqual(['空']);
  });

  it('adopts a completed move after its response is lost, preserving file ID and avoiding another upload', async () => {
    h.writeSource('A.txt', 'A');
    const j = await job('RENAME', false, 'STAGED');
    const move = h.gateway.moveFile.bind(h.gateway);
    const moveSpy = vi.spyOn(h.gateway, 'moveFile').mockImplementationOnce(async (request) => {
      await move(request);
      throw new ShuttleError('BOX_TIMEOUT', '応答なし');
    });
    const upload = vi.spyOn(h.gateway, 'uploadDirect');
    await runUntilIdle(h, 12);
    const item = h.store.listItems(j.id)[0]!;
    expect(item.state).toBe('UNKNOWN_OUTCOME');
    expect(item.resumeState).toBe('MOVING');
    h.store.updateItem(item.id, { nextAttemptAt: null });
    await runUntilIdle(h);
    expect(h.store.getItem(item.id)).toMatchObject({
      state: 'COMPLETED',
      boxFileId: item.boxFileId,
    });
    expect(moveSpy).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('pauses on folder setup failure and resumes without duplicate folders', async () => {
    h.writeSource('A.txt', 'A');
    const j = await job();
    await processCommands(h.ctx);
    await h.newRuntime().tick();
    const ensure = h.gateway.ensureFolder.bind(h.gateway);
    vi.spyOn(h.gateway, 'ensureFolder').mockImplementation(async (parent, name) => {
      const f = await ensure(parent, name);
      if (name === 'source') throw new ShuttleError('BOX_TIMEOUT', '応答なし');
      return f;
    });
    await h.newRuntime().tick();
    expect(h.store.getJob(j.id)).toMatchObject({
      state: 'PAUSED',
      lastErrorCategory: 'BOX_TIMEOUT',
    });
    vi.restoreAllMocks();
    h.store.enqueueCommand(j.id, 'RESUME_JOB');
    await runUntilIdle(h);
    expect(h.store.getJob(j.id)).toMatchObject({ state: 'COMPLETED', lastErrorCategory: null });
    expect((await h.gateway.listFolder(target)).filter((f) => f.type === 'folder')).toHaveLength(1);
  });

  it('drains an in-flight upload on pause and resumes without uploading that file twice', async () => {
    h.writeSource('A.txt', 'A');
    h.writeSource('B.txt', 'B');
    const j = await job();
    await processCommands(h.ctx);
    const runtime = h.newRuntime();
    await runtime.tick();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const direct = h.gateway.uploadDirect.bind(h.gateway);
    const uploads: string[] = [];
    vi.spyOn(h.gateway, 'uploadDirect').mockImplementation(async (request) => {
      uploads.push(request.name);
      await gate;
      return direct(request);
    });
    const tick = runtime.tick();
    try {
      await vi.waitFor(() => expect(uploads.length).toBeGreaterThan(0));
      h.store.setPauseRequested(j.id, true);
    } finally {
      release();
      await tick;
    }
    await runtime.tick();
    expect(h.store.getJob(j.id)?.state).toBe('PAUSED');
    expect(h.store.listItems(j.id).some((i) => i.boxFileId)).toBe(true);
    h.store.enqueueCommand(j.id, 'RESUME_JOB');
    await runUntilIdle(h);
    expect(h.store.getJob(j.id)?.state).toBe('COMPLETED');
    expect(uploads).toHaveLength(2);
    expect(new Set(uploads).size).toBe(2);
  });

  it('does not mark corrupted final content as completed', async () => {
    h.writeSource('A.txt', 'A');
    const j = await job();
    const get = h.gateway.getFile.bind(h.gateway);
    vi.spyOn(h.gateway, 'getFile').mockImplementation(async (id) => {
      const file = await get(id);
      return file?.name === 'A.txt' ? { ...file, sha1: 'changed-content' } : file;
    });
    await runUntilIdle(h);
    expect(h.store.listItems(j.id)[0]).toMatchObject({
      state: 'FAILED',
      lastErrorCategory: 'INTEGRITY_MISMATCH',
    });
  });

  it('rejects a moved destination and never places outside the selected hierarchy', async () => {
    h.writeSource('A.txt', 'A');
    const j = await job();
    await h.scanAndHash(j.id);
    const ctx = await h.jobContext(j.id);
    await prepareFolderTree(ctx, () => false);
    const folder = h.store.listMigrationFolders(j.id)[0]!;
    const get = h.gateway.getFolder.bind(h.gateway);
    vi.spyOn(h.gateway, 'getFolder').mockImplementation(async (id) => {
      const f = await get(id);
      return id === folder.boxFolderId && f ? { ...f, parentFolderId: 'elsewhere' } : f;
    });
    const item = h.store.listItems(j.id)[0]!;
    const move = vi.spyOn(h.gateway, 'moveFile');
    const upload = vi.spyOn(h.gateway, 'uploadDirect');
    await advanceItem(ctx, item.id, TRANSFER_SCOPE);
    expect(upload).not.toHaveBeenCalled();
    expect(h.store.getItem(item.id)?.state).toBe('FAILED');
    expect(move).not.toHaveBeenCalled();
  });

  it('rejects classification commands and cleans up only tracked test files, leaving folders', async () => {
    h.writeSource('A.txt', 'A');
    const j = await job('RENAME', true);
    await runUntilIdle(h);
    for (const type of ['APPROVE_ITEM', 'SELECT_METADATA_TEMPLATE', 'SEND_TO_REVIEW'] as const)
      h.store.enqueueCommand(j.id, type, { itemId: h.store.listItems(j.id)[0]!.id });
    await processCommands(h.ctx);
    expect(h.store.listCommands(j.id).filter((c) => c.state === 'REJECTED')).toHaveLength(3);
    h.store.enqueueCommand(j.id, 'END_TEST');
    await runUntilIdle(h);
    expect(h.store.getJob(j.id)?.cleanupState).toBe('DONE');
    for (const i of h.store.listItems(j.id))
      expect(await h.gateway.getFile(i.boxFileId!)).toBeNull();
    for (const f of h.store.listMigrationFolders(j.id))
      expect(await h.gateway.getFolder(f.boxFolderId!)).not.toBeNull();
  });
  it.each([1, 128])(
    'does not duplicate or claim an unrecorded successful upload (%i bytes)',
    async (size) => {
      h.writeSource('A.txt', 'A'.repeat(size));
      const j = await job('RENAME', true);
      const method = size > 64 ? 'commitUploadSession' : 'uploadDirect';
      let uploadedId: string | null = null;
      if (method === 'uploadDirect') {
        const upload = h.gateway.uploadDirect.bind(h.gateway);
        vi.spyOn(h.gateway, 'uploadDirect').mockImplementationOnce(async (request) => {
          const file = await upload(request);
          uploadedId = file.id;
          throw new ShuttleError('BOX_TIMEOUT', '応答なし');
        });
      } else {
        const commit = h.gateway.commitUploadSession.bind(h.gateway);
        vi.spyOn(h.gateway, 'commitUploadSession').mockImplementationOnce(async (request) => {
          const file = await commit(request);
          uploadedId = file.id;
          throw new ShuttleError('BOX_TIMEOUT', '応答なし');
        });
      }
      await runUntilIdle(h, 12);
      const item = h.store.listItems(j.id)[0]!;
      expect(item.state).toBe('UNKNOWN_OUTCOME');
      h.store.updateItem(item.id, { nextAttemptAt: null });
      await runUntilIdle(h);
      expect(h.store.getItem(item.id)).toMatchObject({
        state: 'FAILED',
        boxFileId: null,
        lastErrorCategory: 'BOX_CONFLICT',
      });
      expect(h.gateway[method]).toHaveBeenCalledTimes(1);
      const files = (await h.gateway.listFolder(item.finalFolderId!)).filter(
        (f) => f.type === 'file',
      );
      expect(files).toHaveLength(1);
      expect(h.store.hasUploadRecord(j.id, item.id, uploadedId!)).toBe(false);
      h.store.enqueueCommand(j.id, 'END_TEST');
      await runUntilIdle(h);
      expect(h.store.getJob(j.id)?.cleanupState).toBe('FAILED');
      expect(await h.gateway.getFile(uploadedId!)).not.toBeNull();
    },
  );

  it('resumes missing chunks after interruption without moving or re-sending completed parts', async () => {
    h.writeSource('A.txt', 'A'.repeat(128));
    const j = await job();
    const uploadPart = h.gateway.uploadPart.bind(h.gateway);
    const parts = vi.spyOn(h.gateway, 'uploadPart').mockImplementation(uploadPart);
    // Fail one part once, leaving the other successful parts on the session.
    parts.mockImplementationOnce(async () => {
      throw new ShuttleError('BOX_TIMEOUT', '一時中断');
    });
    const sessions = vi.spyOn(h.gateway, 'createUploadSession');
    const move = vi.spyOn(h.gateway, 'moveFile');
    await runUntilIdle(h, 12);
    const item = h.store.listItems(j.id)[0]!;
    expect(item.state).toBe('UNKNOWN_OUTCOME');
    h.store.updateItem(item.id, { nextAttemptAt: null });
    await runUntilIdle(h);
    expect(h.store.getItem(item.id)?.state).toBe('COMPLETED');
    expect(sessions).toHaveBeenCalledTimes(1);
    expect(parts).toHaveBeenCalledTimes(5);
    expect(move).not.toHaveBeenCalled();
  });

  it('resumes before upload and after a recorded upload without duplicating files', async () => {
    h.writeSource('A.txt', 'A');
    const j = await job();
    await h.scanAndHash(j.id);
    const ctx = await h.jobContext(j.id);
    await prepareFolderTree(ctx, () => false);
    const item = h.store.listItems(j.id)[0]!;
    const upload = vi.spyOn(h.gateway, 'uploadDirect');
    await advanceItem(ctx, item.id, TRANSFER_SCOPE); // READY
    expect(h.store.getItem(item.id)?.state).toBe('READY');
    await advanceItem(await h.jobContext(j.id), item.id, TRANSFER_SCOPE); // STAGED
    expect(h.store.getItem(item.id)?.state).toBe('STAGED');
    await runUntilIdle(h);
    expect(h.store.getItem(item.id)?.state).toBe('COMPLETED');
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('rejects a different Box version even when its content matches at final verification', async () => {
    h.writeSource('A.txt', 'A');
    const j = await job();
    await h.scanAndHash(j.id);
    const ctx = await h.jobContext(j.id);
    await prepareFolderTree(ctx, () => false);
    const item = h.store.listItems(j.id)[0]!;
    for (let step = 0; step < 4; step++) await advanceItem(ctx, item.id, TRANSFER_SCOPE);
    expect(h.store.getItem(item.id)?.state).toBe('FINAL_VERIFY');
    const get = h.gateway.getFile.bind(h.gateway);
    vi.spyOn(h.gateway, 'getFile').mockImplementation(async (id) => {
      const file = await get(id);
      return file ? { ...file, versionId: 'external-version' } : null;
    });
    await advanceItem(ctx, item.id, ['FINAL_VERIFY']);
    expect(h.store.getItem(item.id)).toMatchObject({
      state: 'FAILED',
      lastErrorCategory: 'BOX_CONFLICT',
    });
  });

  it('never adopts an external same-name same-content file created after preflight', async () => {
    h.writeSource('A.txt', 'A');
    const j = await job('RENAME', true);
    await h.scanAndHash(j.id);
    const ctx = await h.jobContext(j.id);
    await prepareFolderTree(ctx, () => false);
    const item = h.store.listItems(j.id)[0]!;
    await advanceItem(ctx, item.id, TRANSFER_SCOPE);
    const saved = h.store.getItem(item.id)!;
    const external = await h.gateway.uploadDirect({
      parentFolderId: saved.finalFolderId!,
      name: saved.finalName!,
      size: 1,
      sha1Hex: saved.sourceSha1!,
      contentModifiedAt: saved.sourceModifiedAt,
      content: () => ctx.source.openStream(sourceRefOf(saved)),
    });
    const upload = vi.spyOn(h.gateway, 'uploadDirect');
    await advanceItem(ctx, item.id, TRANSFER_SCOPE);
    expect(h.store.getItem(item.id)).toMatchObject({ state: 'FAILED', boxFileId: null });
    expect(upload).not.toHaveBeenCalled();
    h.store.enqueueCommand(j.id, 'END_TEST');
    await runUntilIdle(h);
    expect(await h.gateway.getFile(external.id)).not.toBeNull();
  });
});
