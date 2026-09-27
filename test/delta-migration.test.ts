import { mkdirSync, rmSync, utimesSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectJobDestinations } from '@shuttle-lite/box';
import { sha1Buffer, ShuttleError, type ConflictPolicy } from '@shuttle-lite/core';
import { getDeltaPlan, migrationRuns } from '@shuttle-lite/db';
import { buildReportDocument } from '@shuttle-lite/telemetry';
import { processCommands } from '../apps/worker/src/commands';
import { LocalSourceAdapter } from '../apps/worker/src/source/local';
import { createHarness, runUntilIdle, type Harness } from './harness';

describe('差分移行・既存version更新', () => {
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
  async function initial(policy: ConflictPolicy = 'RENAME') {
    const profile = h.createProfile({ conflictPolicy: policy });
    const j = h.store.createJob({
      profileId: profile.id,
      operatorLabel: 'tester',
      migrationMode: 'AS_IS',
    });
    h.store.saveJobDestinations(
      j.id,
      await collectJobDestinations(h.gateway, target, 'fake', [], false),
    );
    h.store.saveJobMetadata(j.id, []);
    h.store.enqueueCommand(j.id, 'START_JOB');
    await runUntilIdle(h);
    return j;
  }
  async function check(jobId: string) {
    const c = h.store.enqueueCommand(jobId, 'CHECK_DELTA');
    await processCommands(h.ctx);
    expect(h.store.listCommands(jobId).find((x) => x.id === c.id)).toMatchObject({ state: 'DONE' });
    return getDeltaPlan(h.store, jobId)!;
  }
  async function start(jobId: string, excludedPaths: string[] = []) {
    const plan = getDeltaPlan(h.store, jobId)!;
    const c = h.store.enqueueCommand(jobId, 'START_DELTA', { planId: plan.id, excludedPaths });
    await processCommands(h.ctx);
    expect(h.store.listCommands(jobId).find((x) => x.id === c.id)).toMatchObject({ state: 'DONE' });
    return migrationRuns(h.store, jobId).at(-1)!;
  }
  async function externalUpdate(id: string, text: string) {
    const f = (await h.gateway.getFile(id))!;
    const bytes = Buffer.from(text);
    return h.gateway.uploadDirect({
      parentFolderId: f.parentFolderId!,
      name: f.name,
      size: bytes.length,
      sha1Hex: sha1Buffer(bytes),
      content: () => Readable.from(bytes),
      versionTarget: { fileId: id, etag: f.etag! },
    });
  }
  it.each(['small', 'large'])(
    'adds, updates %s content with same ID, preserves history and transfers nothing on the next scan',
    async (size) => {
      h.writeSource('変更.txt', 'old');
      h.writeSource('同じ.txt', 'same');
      const root = await initial();
      const before = h.store.listItems(root.id).find((i) => i.sourceFileName === '変更.txt')!;
      h.writeSource('変更.txt', size === 'small' ? 'new' : 'new'.repeat(100));
      h.writeSource('追加.txt', 'added');
      mkdirSync(join(h.sourceRoot, '空'), { recursive: true });
      const upload = vi.spyOn(h.gateway, 'uploadDirect');
      const commit = vi.spyOn(h.gateway, 'commitUploadSession');
      const p = await check(root.id);
      expect(p.entries.map((e) => [e.path, e.action])).toEqual(
        expect.arrayContaining([
          ['変更.txt', 'UPDATE'],
          ['同じ.txt', 'UNCHANGED'],
          ['追加.txt', 'ADD'],
        ]),
      );
      expect(upload).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled();
      const run = await start(root.id);
      await runUntilIdle(h);
      expect(h.store.getJob(run.id)?.state).toBe('COMPLETED');
      expect(h.store.listItems(run.id).map((i) => i.state)).toEqual(['COMPLETED', 'COMPLETED']);
      const updated = h.store.listItems(run.id).find((i) => i.sourceFileName === '変更.txt')!;
      expect(updated.boxFileId).toBe(before.boxFileId);
      expect(updated.boxFileVersionId).not.toBe(before.boxFileVersionId);
      expect(h.store.getItem(before.id)).toEqual(before);
      expect((await check(root.id)).entries.every((e) => e.action === 'UNCHANGED')).toBe(true);
      expect(migrationRuns(h.store, root.id)).toHaveLength(2);
      expect(h.store.listJobs()).toHaveLength(1);
    },
  );
  it('protects destination edits, detects same-size same-timestamp edits, and preserves source deletions', async () => {
    h.writeSource('両方.txt', 'old');
    h.writeSource('Box.txt', 'old');
    h.writeSource('削除.txt', 'old');
    const root = await initial();
    const files = h.store.listItems(root.id);
    await externalUpdate(files.find((i) => i.sourceFileName === '両方.txt')!.boxFileId!, 'box');
    await externalUpdate(files.find((i) => i.sourceFileName === 'Box.txt')!.boxFileId!, 'box');
    const path = join(h.sourceRoot, '両方.txt');
    const info = statSync(path);
    h.writeSource('両方.txt', 'new');
    utimesSync(path, info.atime, info.mtime);
    rmSync(join(h.sourceRoot, '削除.txt'));
    const p = await check(root.id);
    expect(p.entries.map((e) => [e.path, e.action])).toEqual(
      expect.arrayContaining([
        ['両方.txt', 'CONFLICT'],
        ['Box.txt', 'BOX_CHANGED'],
        ['削除.txt', 'REMOVED'],
      ]),
    );
    expect(
      await h.gateway.getFile(files.find((i) => i.sourceFileName === '削除.txt')!.boxFileId!),
    ).not.toBeNull();
  });
  it('does not publish a partial scan after the share becomes unavailable', async () => {
    h.writeSource('A.txt', 'old');
    const root = await initial();
    vi.spyOn(LocalSourceAdapter.prototype, 'digest').mockRejectedValue(
      new ShuttleError('SOURCE_READ', '共有切断'),
    );
    const c = h.store.enqueueCommand(root.id, 'CHECK_DELTA');
    await processCommands(h.ctx);
    expect(h.store.listCommands(root.id).find((x) => x.id === c.id)?.state).toBe('REJECTED');
    expect(getDeltaPlan(h.store, root.id)).toBeNull();
  });
  it('excludes selected updates and does not mark them as migrated', async () => {
    h.writeSource('A.txt', 'old');
    const root = await initial();
    h.writeSource('A.txt', 'new');
    h.writeSource('B.txt', 'new');
    await check(root.id);
    const run = await start(root.id, ['A.txt']);
    await runUntilIdle(h);
    expect(h.store.listItems(run.id).map((i) => i.sourceFileName)).toEqual(['B.txt']);
    expect(buildReportDocument(h.store, run.id).deltaPlan?.excludedPaths).toEqual(['A.txt']);
    expect((await check(root.id)).entries.find((e) => e.path === 'A.txt')?.action).toBe('UPDATE');
  });
  it.each(['small', 'large'])(
    'reconciles a lost %s version-upload response without an extra version',
    async (size) => {
      h.writeSource('A.txt', 'old');
      const root = await initial();
      h.writeSource('A.txt', size === 'small' ? 'new' : 'new'.repeat(100));
      await check(root.id);
      const run = await start(root.id);
      const method = size === 'small' ? 'uploadDirect' : 'commitUploadSession';
      if (method === 'uploadDirect') {
        const original = h.gateway.uploadDirect.bind(h.gateway);
        vi.spyOn(h.gateway, 'uploadDirect').mockImplementationOnce(async (r) => {
          await original(r);
          throw new ShuttleError('BOX_TIMEOUT', '応答なし');
        });
      } else {
        const original = h.gateway.commitUploadSession.bind(h.gateway);
        vi.spyOn(h.gateway, 'commitUploadSession').mockImplementationOnce(async (r) => {
          await original(r);
          throw new ShuttleError('BOX_TIMEOUT', '応答なし');
        });
      }
      await runUntilIdle(h, 15);
      const item = h.store.listItems(run.id)[0]!;
      const version = (await h.gateway.getFile(item.boxFileId!))!.versionId;
      h.store.updateItem(item.id, { nextAttemptAt: null });
      await runUntilIdle(h);
      expect(h.store.getItem(item.id)?.state).toBe('COMPLETED');
      expect((await h.gateway.getFile(item.boxFileId!))!.versionId).toBe(version);
    },
  );
  it('rejects source changes after planning and destination edits before upload', async () => {
    h.writeSource('A.txt', 'old');
    h.writeSource('B.txt', 'old');
    const root = await initial();
    h.writeSource('A.txt', 'new');
    h.writeSource('B.txt', 'new');
    await check(root.id);
    const old = h.store.listItems(root.id);
    const run = await start(root.id);
    h.writeSource('A.txt', 'changed after plan');
    await externalUpdate(old.find((i) => i.sourceFileName === 'B.txt')!.boxFileId!, 'Box edited');
    await runUntilIdle(h);
    expect(h.store.listItems(run.id).every((i) => i.state === 'FAILED')).toBe(true);
    expect(
      (await h.gateway.getFile(old.find((i) => i.sourceFileName === 'B.txt')!.boxFileId!))!.sha1,
    ).toBe(sha1Buffer(Buffer.from('Box edited')));
  });
  it('retains renamed destination IDs, and overwrites an existing name only when selected', async () => {
    h.writeSource('A.txt', 'old');
    const first = await initial();
    const before = h.store.listItems(first.id)[0]!;
    h.writeSource('A.txt', 'second');
    const second = await initial();
    const renamed = h.store.listItems(second.id)[0]!;
    expect(renamed.finalName).toBe('A (2).txt');
    h.writeSource('A.txt', 'third');
    await check(second.id);
    const run = await start(second.id);
    await runUntilIdle(h);
    expect(h.store.listItems(run.id)[0]!.boxFileId).toBe(renamed.boxFileId);
    const overwrite = await initial('OVERWRITE');
    const result = h.store.listItems(overwrite.id)[0]!;
    expect(result.state).toBe('COMPLETED');
    expect(result.boxFileId).toBe(before.boxFileId);
  });
  it('rejects duplicate plans, overlapping executions, and AI mode', async () => {
    h.writeSource('A.txt', 'old');
    const root = await initial();
    h.writeSource('A.txt', 'new');
    const p = await check(root.id);
    await start(root.id);
    const c = h.store.enqueueCommand(root.id, 'START_DELTA', { planId: p.id });
    await processCommands(h.ctx);
    expect(h.store.listCommands(root.id).find((x) => x.id === c.id)?.state).toBe('REJECTED');
    expect(migrationRuns(h.store, root.id)).toHaveLength(2);
    const ai = h.store.createJob({ profileId: root.profileId, operatorLabel: 'test' });
    h.store.setJobState(ai.id, 'COMPLETED');
    const a = h.store.enqueueCommand(ai.id, 'CHECK_DELTA');
    await processCommands(h.ctx);
    expect(h.store.listCommands(ai.id).find((x) => x.id === a.id)?.state).toBe('REJECTED');
  });
  it('allows a partial failure run to scan again and includes the never-uploaded file', async () => {
    h.writeSource('A.txt', 'old');
    const root = await initial();
    const item = h.store.listItems(root.id)[0]!;
    // 移行元の読取失敗を模した未転送record。遠隔操作は開始していない。
    h.writeSource('B.txt', 'new');
    h.store.upsertScannedItem({
      id: 'failed-item',
      jobId: root.id,
      sourceRelativePath: 'B.txt',
      sourceAbsolutePath: join(h.sourceRoot, 'B.txt'),
      sourceFileName: 'B.txt',
      sourceSize: 3,
      sourceModifiedAt: new Date().toISOString(),
      sourceInode: null,
      fileType: 'txt',
    });
    h.store.updateItem('failed-item', {
      state: 'FAILED',
      resumeState: 'HASHING',
      lastErrorCategory: 'SOURCE_READ',
    });
    expect((await check(root.id)).entries.find((e) => e.path === 'B.txt')?.action).toBe('RETRY');
    const run = await start(root.id);
    await runUntilIdle(h);
    expect(h.store.listItems(run.id)[0]?.state).toBe('COMPLETED');
    expect(h.store.getItem(item.id)).toEqual(item);
  });
  it('preserves the approved delta selection across pause/resume without adding newly appeared files', async () => {
    h.writeSource('A.txt', 'old');
    const root = await initial();
    h.writeSource('A.txt', 'new');
    await check(root.id);
    const run = await start(root.id);
    h.store.enqueueCommand(run.id, 'PAUSE_JOB');
    await runUntilIdle(h);
    h.writeSource('After.txt', 'later');
    h.store.enqueueCommand(run.id, 'RESUME_JOB');
    await runUntilIdle(h);
    expect(h.store.listItems(run.id).map((i) => i.sourceFileName)).toEqual(['A.txt']);
    expect(h.store.getJob(run.id)?.state).toBe('COMPLETED');
    expect((await check(root.id)).entries.find((e) => e.path === 'After.txt')?.action).toBe('ADD');
  });
  it('handles an empty-folder-only delta and refuses an obsolete plan', async () => {
    h.writeSource('A.txt', 'old');
    const root = await initial();
    const old = await check(root.id);
    mkdirSync(join(h.sourceRoot, 'empty'));
    const current = await check(root.id);
    const stale = h.store.enqueueCommand(root.id, 'START_DELTA', { planId: old.id });
    await processCommands(h.ctx);
    expect(h.store.listCommands(root.id).find((c) => c.id === stale.id)?.state).toBe('REJECTED');
    expect(getDeltaPlan(h.store, root.id)?.id).toBe(current.id);
    const run = await start(root.id);
    await runUntilIdle(h);
    expect(h.store.getJob(run.id)?.state).toBe('COMPLETED');
    expect(
      h.store.listMigrationFolders(run.id).find((f) => f.relativePath === 'empty')?.boxFolderId,
    ).toBeTruthy();
  });
  it('guards a chunked replacement when Box changes between prepare and commit', async () => {
    h.writeSource('A.txt', 'old');
    const root = await initial();
    const file = h.store.listItems(root.id)[0]!;
    h.writeSource('A.txt', 'large'.repeat(100));
    await check(root.id);
    const run = await start(root.id);
    const commit = h.gateway.commitUploadSession.bind(h.gateway);
    vi.spyOn(h.gateway, 'commitUploadSession').mockImplementationOnce(async (request) => {
      await externalUpdate(file.boxFileId!, 'external');
      return commit(request);
    });
    await runUntilIdle(h, 15);
    const item = h.store.listItems(run.id)[0]!;
    h.store.updateItem(item.id, { nextAttemptAt: null });
    await runUntilIdle(h);
    expect(h.store.getItem(item.id)?.state).toBe('FAILED');
    expect((await h.gateway.getFile(file.boxFileId!))?.sha1).toBe(
      sha1Buffer(Buffer.from('external')),
    );
  });
  it('invalidates an earlier preview after a failed rescan', async () => {
    h.writeSource('A.txt', 'old');
    const root = await initial();
    h.writeSource('A.txt', 'new');
    const plan = await check(root.id);
    vi.spyOn(LocalSourceAdapter.prototype, 'verifyRoot').mockRejectedValueOnce(
      new ShuttleError('SOURCE_READ', 'offline'),
    );
    h.store.enqueueCommand(root.id, 'CHECK_DELTA');
    await processCommands(h.ctx);
    const command = h.store.enqueueCommand(root.id, 'START_DELTA', { planId: plan.id });
    await processCommands(h.ctx);
    expect(h.store.listCommands(root.id).find((c) => c.id === command.id)?.state).toBe('REJECTED');
    expect(migrationRuns(h.store, root.id)).toHaveLength(1);
  });
});
