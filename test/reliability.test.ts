import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPhaseCounters } from '@shuttle-lite/core';
import { buildJobSnapshot } from '@shuttle-lite/telemetry';
import { createHarness, type Harness } from './harness';
import { getCatalog, getConfig, getStore } from '../apps/web/src/lib/runtime';
import { GET } from '../apps/web/src/app/api/jobs/[jobId]/review/route';

vi.mock('../apps/web/src/lib/runtime', () => ({
  getStore: vi.fn(),
  getCatalog: vi.fn(),
  getConfig: vi.fn(),
}));

describe('large jobs and worker availability', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
    vi.mocked(getStore).mockReturnValue(h.store);
    vi.mocked(getCatalog).mockReturnValue(h.catalog);
    vi.mocked(getConfig).mockReturnValue(h.config);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    h.cleanup();
  });
  function seed(count: number, state: 'COMPLETED' | 'REVIEW_REQUIRED') {
    const job = h.store.createJob({ profileId: h.createProfile().id, operatorLabel: 'test' });
    h.store.transaction(() => {
      for (let i = 0; i < count; i++) {
        const name = `${String(i).padStart(5, '0')}.txt`;
        h.store.upsertScannedItem({
          id: `${job.id}-${i}`,
          jobId: job.id,
          sourceRelativePath: name,
          sourceAbsolutePath: `/test/${name}`,
          sourceFileName: name,
          sourceSize: 10,
          sourceModifiedAt: '2026-09-23T00:00:00Z',
          sourceInode: null,
          fileType: 'txt',
        });
      }
      h.store.db
        .prepare('UPDATE migration_items SET state = ? WHERE job_id = ?')
        .run(state, job.id);
    });
    return job;
  }
  it('aggregates every item and finds active work beyond item 10000', () => {
    const job = seed(10_005, 'COMPLETED');
    h.store.setJobState(job.id, 'RUNNING');
    h.store.updateItem(`${job.id}-10004`, { state: 'AI_PENDING' });
    h.store.updateItem(`${job.id}-10003`, { state: 'FAILED', resumeState: 'UPLOADING' });
    const snapshot = buildJobSnapshot(h.store, job.id)!;
    expect(snapshot.totalItems).toBe(10_005);
    expect(snapshot.completedItems).toBe(10_003);
    expect(snapshot.working).toBe(true);
    expect(snapshot.activeItems.map((item) => item.itemId)).toContain(`${job.id}-10004`);
    expect(snapshot.phases).toEqual(
      buildPhaseCounters(h.store.listItems(job.id, { limit: 20_000 })),
    );
    expect(snapshot.workerUnavailable).toBe(true);
    h.store.heartbeat('worker');
    expect(buildJobSnapshot(h.store, job.id)?.workerUnavailable).toBe(false);
  });
  it('pages and searches all review items through the API, including normalized literal queries', async () => {
    const job = seed(205, 'REVIEW_REQUIRED');
    const call = async (params: string) => {
      const response = await GET(new Request(`http://localhost/review?${params}`), {
        params: Promise.resolve({ jobId: job.id }),
      });
      expect(response.status).toBe(200);
      return response.json() as Promise<{
        items: Array<{ itemId: string; sourceFileName: string }>;
        total: number;
        page: number;
      }>;
    };
    const first = await call('page=1');
    const last = await call('page=3');
    expect(first.items).toHaveLength(100);
    expect(last.items).toHaveLength(5);
    expect(last.total).toBe(205);
    expect(
      new Set(
        [...first.items, ...(await call('page=2')).items, ...last.items].map((item) => item.itemId),
      ).size,
    ).toBe(205);
    const found = await call(`q=${encodeURIComponent('００２０４')}`);
    expect(found.items.map((item: { sourceFileName: string }) => item.sourceFileName)).toEqual([
      '00204.txt',
    ]);
    expect(found.total).toBe(1);
    expect((await call('q=%25')).total).toBe(0);
    expect((await call('page=999')).page).toBe(3);
    expect((await call('page=NaN')).page).toBe(1);
    h.store.db
      .prepare(
        "UPDATE migration_items SET state = 'COMPLETED' WHERE job_id = ? AND source_relative_path >= '00200'",
      )
      .run(job.id);
    expect((await call('page=3')).page).toBe(2);
  });
  it('reports a stopped worker only when the job needs work and recovers on a fresh heartbeat', () => {
    const job = seed(1, 'REVIEW_REQUIRED');
    h.store.setJobState(job.id, 'RUNNING');
    expect(buildJobSnapshot(h.store, job.id)?.workerUnavailable).toBe(false);
    h.store.enqueueCommand(job.id, 'APPROVE_ITEM', { itemId: `${job.id}-0` });
    expect(buildJobSnapshot(h.store, job.id)?.workerUnavailable).toBe(true);
    h.store.heartbeat('one');
    h.store.heartbeat('two');
    h.store.removeHeartbeat('one');
    expect(buildJobSnapshot(h.store, job.id)?.workerUnavailable).toBe(false);
    expect(h.store.isWorkerAvailable(Date.now() + 16_000)).toBe(false);
    h.store.removeHeartbeat('two');
    expect(buildJobSnapshot(h.store, job.id)?.workerUnavailable).toBe(true);
  });
  it('keeps the process heartbeat alive during a long tick and removes it on shutdown', async () => {
    vi.useFakeTimers();
    const runtime = h.newRuntime();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(runtime, 'tick').mockImplementation(async () => {
      await blocked;
      return true;
    });
    const run = runtime.run();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.store.isWorkerAvailable()).toBe(true);
    runtime.requestStop();
    release();
    await run;
    expect(h.store.isWorkerAvailable()).toBe(false);
  });
});
