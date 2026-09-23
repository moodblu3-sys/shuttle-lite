// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviewWorkspace } from '../src/components/review-workspace';
import { saveReviewDraft } from '../src/lib/review-drafts';
import { draftFor } from '../src/lib/review-model';
import type { ReviewItemView } from '../src/lib/review-types';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
const row: ReviewItemView = {
  itemId: 'memo',
  jobId: 'job',
  state: 'NEEDS_REVIEW',
  sourceRelativePath: 'メモ.pdf',
  sourceFileName: 'メモ.pdf',
  sourceSize: 100,
  sourceSha1: 'sha',
  boxFileId: 'box',
  boxSha1: 'sha',
  boxVersionId: '1',
  lastErrorCategory: null,
  lastError: null,
  operatorAction: null,
  needsAttention: false,
  finalName: null,
  suggestedDestinationKey: null,
  hasRoutingDecision: false,
  suggestionSource: 'MANUAL',
  suggestionReason: null,
  extraction: null,
  reviewCommand: null,
};
function page(filter = 'all') {
  return {
    page: 1,
    query: '',
    filter,
    pageSize: 100,
    total: 1,
    allTotal: 1,
    items: filter === 'attention' ? [] : [row],
    metadataTemplates: [],
    counts: { all: 1, ready: 1, unselected: 0, attention: 0 },
    destinationOverrides: { memo: 'contracts' },
  };
}

describe('global review navigation with browser drafts', () => {
  let root: Root;
  let container: HTMLDivElement;
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    localStorage.clear();
    window.history.replaceState(null, '', '/jobs/job/review');
    saveReviewDraft(localStorage, row, { ...draftFor(row), destinationKey: 'contracts' });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  async function render() {
    await act(async () =>
      root.render(
        createElement(ReviewWorkspace, {
          jobId: 'job',
          items: [row],
          boxLinkBase: null,
          defaultOperatorLabel: '担当者',
          needsReviewKey: 'REVIEW',
          destinations: [{ key: 'contracts', label: '契約書', boxPath: '/契約書' }],
          pagination: {
            page: 1,
            query: '',
            pageSize: 100,
            total: 1,
            allTotal: 1,
            filter: 'all',
            counts: { all: 1, ready: 0, unselected: 1, attention: 0 },
          },
        }),
      ),
    );
  }
  async function click(label: string) {
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === label)!
        .click(),
    );
  }
  it('sends destination drafts when filtering, updates URL and supports browser history', async () => {
    fetchMock.mockImplementation(async (_, init) => {
      const query = JSON.parse(init!.body as string);
      expect(query.drafts[0].draft.destinationKey).toBe('contracts');
      return Response.json(page(query.filter));
    });
    await render();
    await click('承認待ち 1');
    expect(container.querySelector('#review-file-memo')).not.toBeNull();
    expect(window.location.search).toContain('filter=ready');
    expect(container.textContent).toContain('未選択 0');
    await click('要対応 0');
    expect(container.querySelector('#review-file-memo')).toBeNull();
    await act(async () => {
      window.history.replaceState(null, '', '/jobs/job/review?page=1&q=&filter=ready');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(container.querySelector('#review-file-memo')).not.toBeNull();
    expect(container.textContent).toContain('0件を選択中');
  });
  it('times out a hung navigation, ignores late results and allows retry', async () => {
    fetchMock.mockResolvedValueOnce(Response.json(page()));
    await render();
    let finish!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await click('要対応 0');
    expect(container.querySelector('[aria-busy=true]')).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(16000));
    expect(container.querySelector('[role=alert]')!.textContent).toContain('時間がかかっています');
    await act(async () => finish(Response.json(page('attention'))));
    expect(container.querySelector('#review-file-memo')).not.toBeNull();
    fetchMock.mockResolvedValue(Response.json(page()));
    await click('再読み込み');
    expect(container.querySelector('[role=alert]')).toBeNull();
  });
});
