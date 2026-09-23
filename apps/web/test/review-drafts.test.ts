// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviewList } from '../src/components/review-list';
import { draftFor } from '../src/lib/review-model';
import { loadReviewDraft, saveReviewDraft } from '../src/lib/review-drafts';
import type { ReviewItemView } from '../src/lib/review-types';

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const item: ReviewItemView = {
  itemId: 'one',
  jobId: 'job',
  state: 'REVIEW_REQUIRED',
  sourceRelativePath: 'contract.pdf',
  sourceFileName: 'contract.pdf',
  sourceSize: 100,
  sourceSha1: 'sha',
  boxFileId: 'file',
  boxSha1: 'sha',
  boxVersionId: 'v1',
  lastErrorCategory: null,
  lastError: null,
  operatorAction: null,
  needsAttention: false,
  finalName: null,
  suggestedDestinationKey: 'A',
  hasRoutingDecision: true,
  suggestionSource: 'AI',
  suggestionReason: null,
  extraction: null,
  reviewCommand: null,
};

describe('persistent review drafts', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    localStorage.clear();
    router.push.mockClear();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  async function render(
    row = item,
    pagination?: { page: number; pageSize: number; total: number; allTotal: number; query: string },
  ) {
    await act(async () =>
      root.render(
        createElement(ReviewList, {
          jobId: row.jobId,
          items: [row],
          boxLinkBase: null,
          defaultOperatorLabel: '担当者',
          needsReviewKey: 'REVIEW',
          pagination,
          destinations: [
            { key: 'A', label: '契約', boxPath: '/契約' },
            { key: 'B', label: '請求', boxPath: '/請求' },
          ],
        }),
      ),
    );
  }
  async function choose(value: string) {
    await act(async () => {
      const select = container.querySelector('select')!;
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }
  async function remount() {
    await act(async () => root.unmount());
    root = createRoot(container);
  }
  it('restores edits after reload without automatically selecting them for approval', async () => {
    await render();
    await choose('B');
    expect(loadReviewDraft(localStorage, item)?.draft.destinationKey).toBe('B');
    await act(async () =>
      container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click(),
    );
    expect(container.textContent).toContain('1件を選択中');
    await remount();
    await render();
    expect(container.querySelector('select')!.value).toBe('B');
    expect(container.textContent).toContain('0件を選択中');
    await render({ ...item, boxVersionId: 'v2' });
    expect(container.querySelector('select')!.value).toBe('A');
    expect(loadReviewDraft(localStorage, { ...item, boxVersionId: 'v2' })).toBeUndefined();
  });
  it('retains drafts for pending and rejected commands, and drops them after a completed command', async () => {
    await render();
    await choose('B');
    const command = { id: 'cmd', createdAt: '2026-09-23T00:00:00Z', rejectionReason: null };
    for (const state of ['PENDING', 'REJECTED'] as const) {
      await remount();
      await render({ ...item, reviewCommand: { ...command, state } });
      expect(container.querySelector('select')!.value).toBe('B');
    }
    await render({ ...item, reviewCommand: { ...command, state: 'DONE' } });
    expect(container.querySelector('select')!.value).toBe('A');
  });
  it('isolates jobs, preserves blank business fields and rejects corrupt or expired drafts', () => {
    const draft = { ...draftFor(item), businessValues: { vendor: '', amount: 0 } };
    saveReviewDraft(localStorage, item, draft);
    expect(loadReviewDraft(localStorage, item)?.draft.businessValues).toEqual({
      vendor: '',
      amount: 0,
    });
    expect(loadReviewDraft(localStorage, { ...item, jobId: 'other' })).toBeUndefined();
    const key = localStorage.key(0)!;
    localStorage.setItem(key, '{broken');
    expect(loadReviewDraft(localStorage, item)).toBeUndefined();
    const saved = saveReviewDraft(localStorage, item, draft);
    localStorage.setItem(key, JSON.stringify({ ...saved, savedAt: Date.now() - 8 * 86400_000 }));
    expect(loadReviewDraft(localStorage, item)).toBeUndefined();
  });
  it('keeps edits in memory and reports storage failure', async () => {
    await render();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    await choose('B');
    expect(container.querySelector('select')!.value).toBe('B');
    expect(container.querySelector('[role=alert]')?.textContent).toContain(
      '下書きを保存できません',
    );
  });
  it('navigates across pages and submits a full-job search', async () => {
    await render(item, { page: 1, pageSize: 100, total: 205, allTotal: 205, query: '' });
    await act(async () =>
      [...container.querySelectorAll('button')].find((b) => b.textContent === '次へ')!.click(),
    );
    expect(router.push).toHaveBeenLastCalledWith('/jobs/job/review?page=2&q=');
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>('input[type=search]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'invoice',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () =>
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(router.push).toHaveBeenLastCalledWith('/jobs/job/review?page=1&q=invoice');
    expect(container.textContent).toContain('1–100 / 205件');
  });
});
