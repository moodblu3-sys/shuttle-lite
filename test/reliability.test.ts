import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPhaseCounters } from '@shuttle-lite/core';
import { buildJobSnapshot } from '@shuttle-lite/telemetry';
import { createHarness, type Harness } from './harness';
import { getCatalog, getConfig, getStore } from '../apps/web/src/lib/runtime';
import { GET, POST } from '../apps/web/src/app/api/jobs/[jobId]/review/route';
import { buildReviewPage } from '../apps/web/src/lib/review';
import { draftFor, reviewRevision } from '../apps/web/src/lib/review-model';

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
  it('filters the whole review job with consistent counts, pending commands and extraction failures', async () => {
    const job = seed(205, 'REVIEW_REQUIRED');
    h.store.saveJobMetadata(job.id, []);
    const destination = h.catalog.entries.find(
      (entry) => entry.key !== h.catalog.needsReviewKey,
    )!.key;
    for (let i = 0; i < 205; i++) {
      h.store.upsertSuggestion({
        itemId: `${job.id}-${i}`,
        suggestedDestinationKey: destination,
        suggestionSource: 'AI',
        suggestionReason: null,
      });
    }
    h.store.updateItem(`${job.id}-201`, { lastErrorCategory: 'BOX_PERMISSION' });
    h.store.saveBusinessMetadata(`${job.id}-202`, 'enterprise/template', {}, 0, 'FAILED');
    h.store.upsertSuggestion({
      itemId: `${job.id}-203`,
      suggestedDestinationKey: h.catalog.needsReviewKey,
      suggestionSource: 'AI',
      suggestionReason: null,
    });
    const command = h.store.enqueueCommand(job.id, 'APPROVE_ITEM', { itemId: `${job.id}-204` });
    const call = async (params: string) => {
      const response = await GET(new Request(`http://localhost/review?${params}`), {
        params: Promise.resolve({ jobId: job.id }),
      });
      return response.json() as Promise<ReturnType<typeof buildReviewPage>>;
    };
    const ready = await call('filter=ready&page=3');
    expect(ready.total).toBe(201);
    expect(ready.items.map((item: { itemId: string }) => item.itemId)).toEqual([`${job.id}-200`]);
    expect(ready.counts).toEqual({ all: 205, ready: 201, unselected: 1, attention: 2 });
    const attention = await call('filter=attention&page=3');
    expect(attention.page).toBe(1);
    expect(attention.items.map((item: { itemId: string }) => item.itemId)).toEqual([
      `${job.id}-201`,
      `${job.id}-202`,
    ]);
    expect(attention.items.every((item: { needsAttention: boolean }) => item.needsAttention)).toBe(
      true,
    );
    expect(
      (await call('filter=unselected')).items.map((item: { itemId: string }) => item.itemId),
    ).toEqual([`${job.id}-203`]);
    const searched = await call('filter=attention&q=００２０２');
    expect(searched.total).toBe(1);
    expect(searched.counts).toEqual({ all: 1, ready: 0, unselected: 0, attention: 1 });
    expect((await call('filter=invalid')).filter).toBe('all');
    h.store.db.prepare("UPDATE job_commands SET state = 'REJECTED' WHERE id = ?").run(command.id);
    expect((await call('filter=ready')).total).toBe(202);
    const otherJob = seed(1, 'REVIEW_REQUIRED');
    expect((await call('filter=all')).allTotal).toBe(205);
    expect(h.store.reviewPage(otherJob.id).allTotal).toBe(1);
  });
  it('includes valid local destination drafts in global filters without persisting or approving them', async () => {
    const job = seed(205, 'REVIEW_REQUIRED');
    const context = { params: Promise.resolve({ jobId: job.id }) };
    const view = buildReviewPage(job.id, 3).items[4]!;
    const destination = h.catalog.entries.find(
      (entry) => entry.key !== h.catalog.needsReviewKey,
    )!.key;
    const saved = {
      revision: reviewRevision(view),
      commandId: null,
      savedAt: Date.now(),
      draft: { ...draftFor(view), destinationKey: destination },
    };
    const call = async (drafts: unknown[], filter = 'ready') => {
      const response = await POST(
        new Request('http://localhost/review', {
          method: 'POST',
          body: JSON.stringify({ page: 1, query: '', filter, drafts }),
        }),
        context,
      );
      expect(response.status).toBe(200);
      return response.json() as Promise<ReturnType<typeof buildReviewPage>>;
    };
    const ready = await call([saved]);
    expect(ready.items.map((row) => row.itemId)).toEqual([view.itemId]);
    expect(ready.counts).toEqual({ all: 205, ready: 1, unselected: 204, attention: 0 });
    expect(ready.destinationOverrides[view.itemId]).toBe(destination);
    expect((await call([saved], 'unselected')).total).toBe(204);
    expect(h.store.getRouting(view.itemId)).toBeNull();
    expect(h.store.listCommands(job.id)).toHaveLength(0);
    expect((await call([{ ...saved, savedAt: 0 }])).total).toBe(0);
    expect((await call([null, {}, { ...saved, revision: '{broken' }])).total).toBe(0);
    const other = seed(1, 'REVIEW_REQUIRED');
    const otherView = buildReviewPage(other.id).items[0]!;
    expect((await call([{ ...saved, revision: reviewRevision(otherView) }])).total).toBe(0);
    h.store.updateItem(view.itemId, { boxFileVersionId: 'changed' });
    expect((await call([saved])).total).toBe(0);
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
