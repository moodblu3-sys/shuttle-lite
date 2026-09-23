// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviewList } from '../src/components/review-list';
import type { ReviewItemView } from '../src/lib/review-types';

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

function item(id = 'one', patch: Partial<ReviewItemView> = {}): ReviewItemView {
  return {
    itemId: id,
    jobId: 'job',
    state: 'REVIEW_REQUIRED',
    sourceRelativePath: `${id}.pdf`,
    sourceFileName: `${id}.pdf`,
    sourceSize: 240,
    sourceSha1: 'digest',
    boxFileId: `box-${id}`,
    boxSha1: 'digest',
    boxVersionId: 'v1',
    lastErrorCategory: null,
    lastError: null,
    operatorAction: null,
    needsAttention: false,
    finalName: null,
    suggestedDestinationKey: 'CONTRACTS',
    hasRoutingDecision: true,
    suggestionSource: 'AI',
    suggestionReason: '契約書',
    extraction: null,
    reviewCommand: null,
    ...patch,
  };
}

describe('review preview interactions', () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.fn<typeof fetch>();
  const url = (suffix: string) => `https://app.box.com/preview/expiring_embed/${suffix}`;
  const response = (suffix: string) => Response.json({ url: url(suffix) });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    router.refresh.mockClear();
    // jsdom does not implement the browser's top layer. Model only open/close here;
    // focus trapping, iframe rendering and visual layout still need a real browser.
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function () {
      this.removeAttribute('open');
    };
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
  async function render(
    items = [item()],
    boxLinkBase: string | null = 'https://app.box.com/file/',
  ) {
    await act(async () =>
      root.render(
        createElement(ReviewList, {
          jobId: 'job',
          items,
          boxLinkBase,
          defaultOperatorLabel: '担当者',
          needsReviewKey: 'NEEDS_REVIEW',
          destinations: [{ key: 'CONTRACTS', label: '契約書', boxPath: '/契約書' }],
        }),
      ),
    );
    if (items.length && !container.querySelector('aside')) {
      await click(items[0]!.sourceFileName);
    }
  }
  function button(text: string) {
    const element = [...container.querySelectorAll('button')].find(
      (b) =>
        b.textContent === text ||
        b.getAttribute('aria-label') === text ||
        b.querySelector('strong')?.textContent === text,
    );
    if (!element) throw new Error(`Button not found: ${text}`);
    return element;
  }
  async function click(text: string) {
    const element = button(text);
    element.focus();
    await act(async () => element.click());
  }
  function input(label: string) {
    const element = [...container.querySelectorAll('label')]
      .find((l) => l.textContent === label)
      ?.querySelector('input');
    if (!element) throw new Error(`Input not found: ${label}`);
    return element;
  }

  it('preserves edits, selection and iframe through polling; reopening fetches a new URL', async () => {
    fetchMock.mockResolvedValueOnce(response('first')).mockResolvedValueOnce(response('second'));
    await render();
    expect(fetchMock).not.toHaveBeenCalled();
    const metadata = input('識別情報');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        metadata,
        'edited-value',
      );
      metadata.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => checkbox.click());
    expect(checkbox.checked).toBe(true);
    await click('プレビュー');
    const frame = container.querySelector('iframe')!;
    expect(frame.src).toBe(url('first'));
    await act(async () => {
      vi.advanceTimersByTime(3100);
    });
    expect(router.refresh).toHaveBeenCalled();
    await render([{ ...item() }]);
    expect(container.querySelector('iframe')).toBe(frame);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await click('プレビューを閉じる');
    expect(container.querySelector('iframe')).toBeNull();
    expect(document.activeElement).toBe(button('プレビュー'));
    expect(input('識別情報').value).toBe('edited-value');
    expect(checkbox.checked).toBe(true);
    expect(button('選択した1件を承認').disabled).toBe(false);
    await click('プレビュー');
    expect(container.querySelector('iframe')?.src).toBe(url('second'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('aborts a closed request and ignores its late response after another file is opened', async () => {
    let finishOld!: (value: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    );
    fetchMock.mockResolvedValueOnce(response('two'));
    await render([item(), item('two')]);
    await click('プレビュー');
    const signal = fetchMock.mock.calls[0]![1]!.signal!;
    await click('プレビューを閉じる');
    expect(signal.aborted).toBe(true);
    await click('two.pdf');
    await click('プレビュー');
    await act(async () => finishOld(response('old')));
    expect(container.querySelector('iframe')?.src).toBe(url('two'));
    expect(container.querySelector('dialog h2')?.textContent).toBe('two.pdf');
  });

  it('disposes the preview when the file version changes or the item disappears', async () => {
    fetchMock.mockResolvedValue(response('first'));
    await render();
    await click('プレビュー');
    await render([item('one', { boxVersionId: 'v2' })]);
    expect(container.querySelector('dialog')).toBeNull();
    await click('プレビュー');
    await render([]);
    expect(container.querySelector('dialog')).toBeNull();
    expect(document.body.style.overflow).toBe('');
  });

  it('keeps close/original available on errors and honors rate-limit retry delay', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json(
        { message: '時間をおいて再読み込みしてください' },
        { status: 429, headers: { 'Retry-After': '12' } },
      ),
    );
    fetchMock.mockResolvedValueOnce(response('retry'));
    await render();
    await click('プレビュー');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('再読み込み');
    expect(button('再読み込み').disabled).toBe(true);
    expect(button('プレビューを閉じる').disabled).toBe(false);
    expect(container.querySelector('dialog a')?.getAttribute('href')).toBe(
      'https://app.box.com/file/box-one',
    );
    await act(async () => {
      vi.advanceTimersByTime(12000);
    });
    expect(button('再読み込み').disabled).toBe(false);
    await click('再読み込み');
    expect(container.querySelector('iframe')?.src).toBe(url('retry'));
  });

  it('supports Escape via cancel and hides preview in fake mode', async () => {
    fetchMock.mockResolvedValue(response('first'));
    await render();
    await click('プレビュー');
    await act(async () => {
      container.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }));
    });
    expect(container.querySelector('dialog')).toBeNull();
    await render([item()], null);
    expect(container.textContent).not.toContain('プレビュー');
  });

  it('times out a hung request and does not accept its later response', async () => {
    let finish!: (value: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    await click('プレビュー');
    await act(async () => {
      vi.advanceTimersByTime(25000);
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      '時間がかかっています',
    );
    expect(fetchMock.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    await act(async () => finish(response('late')));
    expect(container.querySelector('iframe')).toBeNull();
  });
});
