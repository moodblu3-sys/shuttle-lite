import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mapResponseError } from '@shuttle-lite/box';
import { ShuttleError, type ErrorCategory } from '@shuttle-lite/core';
import { createHarness, runUntilIdle, type Harness } from './harness';
import { advanceItem, ROUTING_SCOPE } from '../apps/worker/src/pipeline';
import { getCatalog, getConfig, getStore } from '../apps/web/src/lib/runtime';
import { buildReviewPage } from '../apps/web/src/lib/review';
import {
  bulkReviewItems,
  draftFor,
  groupReviewItems,
  reviewRevision,
} from '../apps/web/src/lib/review-model';

vi.mock('../apps/web/src/lib/runtime', () => ({
  getStore: vi.fn(),
  getCatalog: vi.fn(),
  getConfig: vi.fn(),
}));

describe('review after a transient AI failure', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
    vi.mocked(getStore).mockReturnValue(h.store);
    vi.mocked(getCatalog).mockReturnValue(h.catalog);
    vi.mocked(getConfig).mockReturnValue(h.config);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    h.cleanup();
  });

  async function start(error: ShuttleError) {
    h.writeSource('A社_打合せメモ.docx', 'A社との打合せ。次回の予定を確認した。');
    const job = h.store.createJob({ profileId: h.createProfile().id, operatorLabel: 'test' });
    h.store.saveJobMetadata(job.id, []);
    h.gateway.failNext('extractStructured', error);
    h.store.enqueueCommand(job.id, 'START_JOB');
    await runUntilIdle(h);
    return h.store.listItems(job.id)[0]!;
  }

  async function legacyRecovered() {
    const failed = await start(
      new ShuttleError('UPLOAD_PART_MISMATCH', 'Box API 412 precondition_failed'),
    );
    h.store.updateItem(failed.id, { nextAttemptAt: null });
    await runUntilIdle(h);
    // 旧版の成功後の保存内容を、テスト専用DBで再現する。
    h.store.updateItem(failed.id, {
      lastErrorCategory: failed.lastErrorCategory,
      lastError: failed.lastError,
    });
    return h.store.getItem(failed.id)!;
  }

  it('clears the current error after retry success, preserving history and the uploaded file', async () => {
    const upload = vi.spyOn(h.gateway, 'uploadDirect');
    const failed = await start(
      mapResponseError(412, {}, JSON.stringify({ code: 'precondition_failed' }), {
        method: 'POST',
        url: 'https://api.box.com/2.0/ai/extract_structured',
      }),
    );
    expect(failed).toMatchObject({
      state: 'RETRY_WAIT',
      lastErrorCategory: 'AI_NOT_READY',
      uploadStrategy: 'DIRECT',
      retryCount: 1,
    });
    expect(failed.nextAttemptAt).not.toBeNull();
    await advanceItem(await h.jobContext(failed.jobId), failed.id, ROUTING_SCOPE);
    const recovered = h.store.getItem(failed.id)!;
    expect(recovered).toMatchObject({
      state: 'REVIEW_REQUIRED',
      lastError: null,
      lastErrorCategory: null,
      nextAttemptAt: null,
      attempts: 0,
      retryCount: 1,
      boxFileId: failed.boxFileId,
    });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(
      h.store
        .listEvents(failed.jobId)
        .some((event) => event.status === 'RETRYING' && event.errorCategory === 'AI_NOT_READY'),
    ).toBe(true);
    const page = buildReviewPage(failed.jobId);
    expect(page.counts).toEqual({ all: 1, ready: 0, unselected: 1, attention: 0 });
    expect(page.items[0]).toMatchObject({ needsAttention: false, lastError: null });
  });

  it('does not swallow a persistent 412 after exhausting the retry budget', async () => {
    const error = new ShuttleError('AI_NOT_READY', 'Box API 412 precondition_failed');
    const failed = await start(error);
    vi.spyOn(h.gateway, 'extractStructured').mockRejectedValue(error);
    const ctx = await h.jobContext(failed.jobId);
    for (let attempt = 1; attempt < h.config.limits.maxAttempts; attempt++) {
      await advanceItem(ctx, failed.id, ROUTING_SCOPE);
    }
    expect(h.store.getItem(failed.id)).toMatchObject({
      state: 'FAILED',
      lastErrorCategory: 'AI_NOT_READY',
      lastError: error.message,
    });
  });

  it('projects legacy recovered errors consistently without changing the item or event records', async () => {
    const item = await legacyRecovered();
    const events = h.store.listEvents(item.jobId);
    const all = buildReviewPage(item.jobId);
    const unselected = buildReviewPage(item.jobId, 1, '', 'unselected');
    const attention = buildReviewPage(item.jobId, 1, '', 'attention');
    expect(all.counts).toEqual({ all: 1, ready: 0, unselected: 1, attention: 0 });
    expect(unselected.items.map((row) => row.itemId)).toEqual([item.id]);
    expect(attention.total).toBe(0);
    expect(all.items[0]).toMatchObject({
      needsAttention: false,
      lastErrorCategory: null,
      lastError: null,
      operatorAction: null,
    });
    expect(all.items[0]!.suggestionReason).toBe(h.store.latestExtraction(item.id)!.reason);
    expect(h.store.getItem(item.id)).toEqual(item);
    expect(h.store.listEvents(item.jobId)).toEqual(events);

    const destinations = h.catalog.entries;
    const row = all.items[0]!;
    expect(groupReviewItems([row], destinations, h.catalog.needsReviewKey).undecided).toEqual([
      row,
    ]);
    const destinationKey = destinations.find(
      (entry) => entry.key !== h.catalog.needsReviewKey,
    )!.key;
    const draft = () => ({ ...draftFor(row), destinationKey });
    expect(
      bulkReviewItems(
        [row],
        new Map([[row.itemId, reviewRevision(row)]]),
        draft,
        destinations,
        h.catalog.needsReviewKey,
      ),
    ).toEqual([row]);
    const ready = h.store.reviewPage(item.jobId, 1, '', {
      filter: 'ready',
      destinationKeys: [destinationKey],
      destinationOverrides: { [item.id]: destinationKey },
    });
    expect(ready.counts).toEqual({ all: 1, ready: 1, unselected: 0, attention: 0 });
  });

  it.each([
    'missing-success',
    'later-failure',
    'different-file',
    'needs-review',
    'resume-pending',
    'MOVE_CONFLICT',
    'APPROVAL_STALE',
    'BOX_PERMISSION',
    'metadata-failed',
  ])('keeps %s actionable and excludes it from bulk approval', async (kind) => {
    const item = await legacyRecovered();
    if (kind === 'missing-success') {
      h.store.db
        .prepare(
          "DELETE FROM migration_events WHERE item_id = ? AND phase = 'AI_EXTRACTION' AND status = 'SUCCEEDED'",
        )
        .run(item.id);
    } else if (kind === 'later-failure') {
      h.store.appendEvent({
        jobId: item.jobId,
        itemId: item.id,
        phase: 'AI_EXTRACTION',
        status: 'RETRYING',
        errorCategory: 'UPLOAD_PART_MISMATCH',
      });
    } else if (kind === 'different-file') {
      h.store.updateItem(item.id, { boxFileId: 'different' });
    } else if (kind === 'needs-review') {
      h.store.updateItem(item.id, { state: 'NEEDS_REVIEW' });
    } else if (kind === 'resume-pending') {
      h.store.updateItem(item.id, { resumeState: 'AI_PENDING' });
    } else if (kind === 'metadata-failed') {
      h.store.saveBusinessMetadata(item.id, 'enterprise/test', {}, 0, 'FAILED');
    } else {
      h.store.updateItem(item.id, { lastErrorCategory: kind as ErrorCategory });
    }
    const page = buildReviewPage(item.jobId, 1, '', 'attention');
    expect(page.counts).toEqual({ all: 1, ready: 0, unselected: 0, attention: 1 });
    const row = page.items[0]!;
    expect(row.needsAttention).toBe(true);
    const destinationKey = h.catalog.entries.find(
      (entry) => entry.key !== h.catalog.needsReviewKey,
    )!.key;
    expect(
      bulkReviewItems(
        [row],
        new Map([[row.itemId, reviewRevision(row)]]),
        () => ({ ...draftFor(row), destinationKey }),
        h.catalog.entries,
        h.catalog.needsReviewKey,
      ),
    ).toEqual([]);
  });
});
