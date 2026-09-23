// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviewList } from '../src/components/review-list';
import type { ReviewItemView } from '../src/lib/review-types';

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
const destinations = [
  { key: 'contracts', label: '契約書', boxPath: '/契約書' },
  { key: 'invoices', label: '請求書', boxPath: '/請求書' },
];
function item(id: string, patch: Partial<ReviewItemView> = {}): ReviewItemView {
  return {
    itemId: id,
    jobId: 'job',
    state: 'REVIEW_REQUIRED',
    sourceRelativePath: `${id}.pdf`,
    sourceFileName: `${id}.pdf`,
    sourceSize: 100,
    sourceSha1: 'sha',
    boxFileId: `box-${id}`,
    boxSha1: 'sha',
    boxVersionId: 'v1',
    lastErrorCategory: null,
    lastError: null,
    operatorAction: null,
    needsAttention: false,
    finalName: null,
    suggestedDestinationKey: 'contracts',
    hasRoutingDecision: true,
    suggestionSource: 'AI',
    suggestionReason: null,
    extraction: null,
    reviewCommand: null,
    ...patch,
  };
}
const rows = [
  item('契約'),
  item('請求', { suggestedDestinationKey: 'invoices' }),
  item('メモ', { hasRoutingDecision: false, suggestedDestinationKey: null }),
  item('抽出失敗', { needsAttention: true }),
  item('処理中', {
    reviewCommand: { id: 'cmd', state: 'PENDING', createdAt: '2026-09-23', rejectionReason: null },
  }),
];

describe('review workspace', () => {
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
    vi.unstubAllGlobals();
  });
  async function render(items = rows, pagination?: Parameters<typeof ReviewList>[0]['pagination']) {
    await act(async () =>
      root.render(
        createElement(ReviewList, {
          jobId: 'job',
          items,
          destinations,
          needsReviewKey: 'REVIEW',
          defaultOperatorLabel: '担当者',
          boxLinkBase: null,
          pagination,
        }),
      ),
    );
  }
  async function click(text: string) {
    const button = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === text || b.getAttribute('aria-label') === text,
    )!;
    expect(button).toBeDefined();
    await act(async () => button.click());
  }
  async function open(id: string) {
    await act(async () =>
      container.querySelector<HTMLButtonElement>(`#review-file-${id}`)!.click(),
    );
  }
  function files() {
    return [...container.querySelectorAll('button[id^=review-file-]')].map(
      (b) => b.querySelector('strong')!.textContent,
    );
  }
  it('opens details on demand and restores focus and edits after closing', async () => {
    await render();
    expect(container.querySelector('aside')).toBeNull();
    await open('契約');
    await act(async () => {
      const select = container.querySelector('select')!;
      select.value = 'invoices';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await click('詳細を閉じる');
    expect(container.querySelector('aside')).toBeNull();
    expect(document.activeElement?.id).toBe('review-file-契約');
    await render([...rows]);
    expect(container.querySelector('aside')).toBeNull();
    await open('契約');
    expect(container.querySelector('select')!.value).toBe('invoices');
  });
  it('filters categories, clears hidden selections and approves only visible eligible files', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({
        command: {
          id: 'accepted',
          state: 'PENDING',
          createdAt: '2026-09-23T12:00:00Z',
          rejectionReason: null,
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await render();
    await act(async () =>
      container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click(),
    );
    await click('未選択 1');
    expect(files()).toEqual(['メモ.pdf']);
    expect(container.textContent).toContain('0件を選択中');
    expect(container.querySelector('input[type=checkbox]')).toBeNull();
    await click('要対応 1');
    expect(files()).toEqual(['抽出失敗.pdf']);
    await click('承認待ち 2');
    expect(files()).toEqual(['契約.pdf', '請求.pdf']);
    await act(async () => {
      container
        .querySelectorAll<HTMLInputElement>('input[type=checkbox]')
        .forEach((input) => input.click());
    });
    await click('選択した2件を承認');
    expect(
      fetchMock.mock.calls.map(([, init]) => JSON.parse(init!.body as string).payload.itemId),
    ).toEqual(['契約', '請求']);
    expect(files()).toEqual([]);
    expect(container.textContent).toContain('0件を選択中');
  });
  it('search does not approve a selected row hidden by the query', async () => {
    await render();
    await act(async () =>
      container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click(),
    );
    await act(async () => {
      const input = container.querySelector('input[type=search]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'メモ',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(files()).toEqual(['メモ.pdf']);
    expect(container.textContent).toContain('0件を選択中');
  });
  it('requests global filters from page one, preserving the applied search', async () => {
    await render([rows[0]!], {
      page: 2,
      pageSize: 100,
      total: 205,
      allTotal: 300,
      query: '契約',
      filter: 'all',
      counts: { all: 205, ready: 180, unselected: 20, attention: 5 },
    });
    await click('要対応 5');
    expect(router.push).toHaveBeenLastCalledWith(
      '/jobs/job/review?page=1&q=%E5%A5%91%E7%B4%84&filter=attention',
    );
  });
});
