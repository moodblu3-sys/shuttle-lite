import { applyRuntimeSettings, settingsFromConfig } from '@shuttle-lite/config';
import { ConfiguredTelemetrySink, OutboxSender } from '@shuttle-lite/telemetry';
import { hostname } from 'node:os';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShuttleError } from '@shuttle-lite/core';
import { recoverDeadCleanupLeases } from '../apps/worker/src/test-cleanup';
import { processCommands } from '../apps/worker/src/commands';
import { approveItem, createHarness, runUntilIdle, type Harness } from './harness';

describe('test run cleanup', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    h.cleanup();
  });
  async function staged(testMode = true, businessMode = false) {
    h.writeSource('契約書.txt', '業務委託契約書 契約番号 LEG-2026-0042');
    h.writeSource('検討メモ.txt', '検討メモ 案件未定');
    const job = h.store.createJob({
      profileId: h.createProfile().id,
      operatorLabel: 'test',
      testMode,
    });
    if (businessMode) h.store.saveJobMetadata(job.id, []);
    h.store.enqueueCommand(job.id, 'START_JOB');
    await runUntilIdle(h);
    return job;
  }
  it('deletes only this run, including an unapproved item; preserves originals, folders and other runs', async () => {
    const job = await staged();
    const other = await staged(false);
    const items = h.store.listItems(job.id);
    approveItem(h, items[0]!, h.catalog.entries[0]!.key);
    await runUntilIdle(h);
    const placed = h.store.getItem(items[0]!.id)!;
    expect(placed.state).toBe('COMPLETED');
    h.store.enqueueCommand(job.id, 'END_TEST');
    await runUntilIdle(h);
    expect(h.store.getJob(job.id)).toMatchObject({ cleanupState: 'DONE', pauseRequested: true });
    expect(h.store.getJob(job.id)!.cleanupMessage).toContain('2件');
    for (const item of items) expect(await h.gateway.getFile(item.boxFileId!)).toBeNull();
    for (const item of h.store.listItems(other.id))
      expect(await h.gateway.getFile(item.boxFileId!)).not.toBeNull();
    expect(await h.gateway.getFolder(placed.finalFolderId!)).not.toBeNull();
    expect(existsSync(join(h.sourceRoot, '契約書.txt'))).toBe(true);
    expect(h.store.listItems(job.id)).toHaveLength(2);
    h.store.enqueueCommand(job.id, 'RESCAN_JOB');
    await runUntilIdle(h);
    expect(h.store.listCommands(job.id).find((c) => c.type === 'RESCAN_JOB')!.state).toBe(
      'REJECTED',
    );
  });
  it('cleans new metadata jobs before and after approval without a legacy metadata instance', async () => {
    const job = await staged(true, true);
    const items = h.store.listItems(job.id);
    expect(await h.gateway.getMetadata(items[0]!.boxFileId!)).toBeNull();
    approveItem(h, items[0]!, h.catalog.entries[0]!.key);
    await runUntilIdle(h);
    expect(h.store.getItem(items[0]!.id)?.state).toBe('COMPLETED');
    h.store.enqueueCommand(job.id, 'END_TEST');
    await runUntilIdle(h);
    expect(h.store.getJob(job.id)?.cleanupState).toBe('DONE');
    for (const item of items) expect(await h.gateway.getFile(item.boxFileId!)).toBeNull();
  });
  it('keeps new-mode files without a matching upload record or moved to another candidate', async () => {
    const job = await staged(true, true);
    const items = h.store.listItems(job.id);
    h.store.db
      .prepare("DELETE FROM migration_events WHERE item_id = ? AND phase = 'UPLOAD'")
      .run(items[0]!.id);
    await h.gateway.moveFile({
      fileId: items[1]!.boxFileId!,
      targetFolderId: h.ctx.layout.destinations[h.catalog.entries[0]!.key]!,
    });
    const remove = vi.spyOn(h.gateway, 'deleteTestFile');
    h.store.enqueueCommand(job.id, 'END_TEST');
    await runUntilIdle(h);
    expect(h.store.getJob(job.id)?.cleanupState).toBe('FAILED');
    expect(remove).not.toHaveBeenCalled();
  });
  it('refuses a normal run even if a cleanup command bypasses the web API', async () => {
    const job = await staged(false);
    const remove = vi.spyOn(h.gateway, 'deleteTestFile');
    h.store.enqueueCommand(job.id, 'END_TEST');
    await runUntilIdle(h);
    expect(remove).not.toHaveBeenCalled();
    expect(h.store.getJob(job.id)!.cleanupState).toBe('NONE');
    expect(h.store.listCommands(job.id).find((c) => c.type === 'END_TEST')!.state).toBe('REJECTED');
  });
  it('keeps files with foreign provenance and retries only unresolved files', async () => {
    const job = await staged();
    const items = h.store.listItems(job.id);
    const file = items[0]!;
    await h.gateway.updateMetadata(file.boxFileId!, { migrationJobId: 'another-run' });
    h.store.enqueueCommand(job.id, 'END_TEST');
    await runUntilIdle(h);
    expect(h.store.getJob(job.id)!.cleanupState).toBe('FAILED');
    expect(await h.gateway.getFile(file.boxFileId!)).not.toBeNull();
    expect(await h.gateway.getFile(items[1]!.boxFileId!)).toBeNull();
    await h.gateway.updateMetadata(file.boxFileId!, { migrationJobId: job.id });
    const remove = vi.spyOn(h.gateway, 'deleteTestFile');
    h.store.enqueueCommand(job.id, 'END_TEST');
    await runUntilIdle(h);
    expect(h.store.getJob(job.id)!.cleanupState).toBe('DONE');
    expect(remove).toHaveBeenCalledTimes(1);
  });
  it('does not steal even an expired active upload lease', async () => {
    const job = await staged();
    h.store.db
      .prepare('UPDATE migration_jobs SET lease_owner = ?, lease_expires_at = ? WHERE id = ?')
      .run('other-worker', '2000-01-01T00:00:00.000Z', job.id);
    const remove = vi.spyOn(h.gateway, 'deleteTestFile');
    h.store.enqueueCommand(job.id, 'END_TEST');
    await runUntilIdle(h);
    expect(h.store.getJob(job.id)!.cleanupState).toBe('REQUESTED');
    expect(remove).not.toHaveBeenCalled();
    h.store.releaseLease(job.id, 'other-worker');
    await runUntilIdle(h);
    expect(h.store.getJob(job.id)!.cleanupState).toBe('DONE');
  });
  it('keeps externally moved files and does not call cleanup twice for repeated requests', async () => {
    const job = await staged();
    const file = h.store.listItems(job.id)[0]!;
    const outside = await h.gateway.ensureFolder('0', 'outside');
    await h.gateway.moveFile({ fileId: file.boxFileId!, targetFolderId: outside.id });
    h.store.enqueueCommand(job.id, 'END_TEST');
    h.store.enqueueCommand(job.id, 'END_TEST');
    await runUntilIdle(h);
    expect(h.store.getJob(job.id)!.cleanupState).toBe('FAILED');
    expect(await h.gateway.getFile(file.boxFileId!)).not.toBeNull();
  });
  it('reports an API failure and succeeds after a retry without re-deleting successful files', async () => {
    const job = await staged();
    const remove = vi
      .spyOn(h.gateway, 'deleteTestFile')
      .mockRejectedValueOnce(new ShuttleError('BOX_PERMISSION', 'permission denied'));
    h.store.enqueueCommand(job.id, 'END_TEST');
    await runUntilIdle(h);
    expect(h.store.getJob(job.id)!.cleanupState).toBe('FAILED');
    h.store.enqueueCommand(job.id, 'END_TEST');
    await runUntilIdle(h);
    expect(h.store.getJob(job.id)!.cleanupState).toBe('DONE');
    expect(remove).toHaveBeenCalledTimes(3);
  });
  it('refuses etag races and missing IDs instead of claiming success', async () => {
    const job = await staged();
    const file = h.store.listItems(job.id)[0]!;
    const original = h.gateway.deleteTestFile.bind(h.gateway);
    vi.spyOn(h.gateway, 'deleteTestFile').mockImplementationOnce(async (id, etag) => {
      await h.gateway.updateMetadata(id, { changed: 'yes' });
      return original(id, etag);
    });
    h.store.enqueueCommand(job.id, 'END_TEST');
    await runUntilIdle(h);
    expect(h.store.getJob(job.id)!.cleanupState).toBe('FAILED');
    expect(await h.gateway.getFile(file.boxFileId!)).not.toBeNull();
  });
  it('recovers cleanup only when the owning local process is proven dead', async () => {
    const job = await staged();
    h.store.requestTestCleanup(job.id);
    const owner = `${hostname()}-1234567-w_dead`;
    h.store.claimTestCleanup(owner);
    const probe = vi.spyOn(process, 'kill').mockReturnValue(true);
    recoverDeadCleanupLeases(h.ctx);
    expect(h.store.getJob(job.id)!.leaseOwner).toBe(owner);
    probe.mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    recoverDeadCleanupLeases(h.ctx);
    expect(h.store.getJob(job.id)).toMatchObject({ leaseOwner: null, cleanupState: 'REQUESTED' });
    probe.mockRestore();
    await runUntilIdle(h);
    expect(h.store.getJob(job.id)!.cleanupState).toBe('DONE');
  });

  it('keeps a document whose content version changed after migration', async () => {
    const job = await staged();
    const item = h.store.listItems(job.id)[0]!;
    const get = h.gateway.getFile.bind(h.gateway);
    vi.spyOn(h.gateway, 'getFile').mockImplementation(async (id) => {
      const file = await get(id);
      return file && id === item.boxFileId ? { ...file, versionId: 'new-version' } : file;
    });
    h.store.enqueueCommand(job.id, 'END_TEST');
    await runUntilIdle(h);
    expect(h.store.getJob(job.id)!.cleanupState).toBe('FAILED');
    expect(await get(item.boxFileId!)).not.toBeNull();
  });

  it('preserves edited settings and sends cleanup events to the selected log folder', async () => {
    const job = await staged();
    const folder = join(h.dataDir, 'selected-logs');
    mkdirSync(folder);
    const settings = {
      ...settingsFromConfig(h.config),
      fileConcurrency: 1,
      chunkConcurrency: 1,
      logFolder: folder,
    };
    h.store.saveRuntimeSettings(settings, 0);
    h.store.enqueueCommand(job.id, 'END_TEST');
    await runUntilIdle(h);
    expect(h.store.getJob(job.id)!.cleanupState).toBe('DONE');
    expect(h.store.getRuntimeSettings()).toEqual({ revision: 1, settings });
    const sink = new ConfiguredTelemetrySink(() =>
      applyRuntimeSettings(h.config, h.store.getRuntimeSettings().settings),
    );
    const sender = new OutboxSender({ store: h.store, sink, batchSize: 1000 });
    await sender.runOnce();
    const output = readFileSync(join(folder, 'events.jsonl'), 'utf8');
    const deleted = h.store
      .listEvents(job.id)
      .filter((e) => e.message?.includes('転送ファイルを削除しました'));
    expect(deleted).toHaveLength(2);
    for (const event of deleted) expect(output).toContain(event.id);
    await sender.close();
  });

  it('ends an empty test and rejects subsequent mutation commands', async () => {
    const job = h.store.createJob({
      profileId: h.createProfile().id,
      operatorLabel: 'test',
      testMode: true,
    });
    h.store.enqueueCommand(job.id, 'END_TEST');
    await runUntilIdle(h);
    expect(h.store.getJob(job.id)!.cleanupState).toBe('DONE');
    h.store.enqueueCommand(job.id, 'START_JOB');
    await processCommands(h.ctx);
    expect(h.store.listCommands(job.id).find((c) => c.type === 'START_JOB')!.state).toBe(
      'REJECTED',
    );
  });
});
