// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviewDestinationPane } from '../src/components/review-destination-pane';

const destinations = [
  { key: 'a', label: 'Aの契約書', boxPath: '/コスモス株式会社/ABCプロジェクト/契約書' },
  { key: 'b', label: 'Bの契約書', boxPath: '/コスモス株式会社/別プロジェクト/契約書' },
  { key: 'invoice', label: '請求書', boxPath: '/コスモス株式会社/ABCプロジェクト/請求書' },
  { key: 'REVIEW', label: '要確認', boxPath: '/Shuttle Lite/一時保管' },
];

describe('review destination pane', () => {
  let container: HTMLDivElement;
  let root: Root;
  const apply = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    apply.mockClear();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  async function render(patch: Partial<Parameters<typeof ReviewDestinationPane>[0]> = {}) {
    await act(async () =>
      root.render(
        createElement(ReviewDestinationPane, {
          destinations,
          needsReviewKey: 'REVIEW',
          count: 3,
          disabled: false,
          onApply: apply,
          ...patch,
        }),
      ),
    );
  }
  function button(name: string) {
    const result = [...container.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === name || b.textContent === name,
    );
    expect(result).toBeDefined();
    return result!;
  }
  async function click(name: string) {
    await act(async () => button(name).click());
  }
  async function search(text: string) {
    await act(async () => {
      const input = container.querySelector('input')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  it('uses distinct catalog keys for equal names, and applies only after confirmation', async () => {
    await render();
    expect(container.textContent).not.toContain('Shuttle Lite');
    expect(container.querySelector('[aria-label="コスモス株式会社を配置先に選択"]')).toBeNull();
    expect(button('選択した3件の配置先に指定').disabled).toBe(true);
    await click('コスモス株式会社/別プロジェクト/契約書を配置先に選択');
    expect(apply).not.toHaveBeenCalled();
    await click('選択した3件の配置先に指定');
    expect(apply).toHaveBeenLastCalledWith('b');
    await click('コスモス株式会社/ABCプロジェクト/契約書を配置先に選択');
    await click('選択した3件の配置先に指定');
    expect(apply).toHaveBeenLastCalledWith('a');
  });
  it('searches descendants of collapsed folders and shows a useful empty state', async () => {
    await render();
    await click('コスモス株式会社を折りたたむ');
    expect(
      container.querySelector(
        '[aria-label="コスモス株式会社/ABCプロジェクト/請求書を配置先に選択"]',
      ),
    ).toBeNull();
    await search('請求書');
    expect(button('コスモス株式会社/ABCプロジェクト/請求書を配置先に選択')).toBeDefined();
    expect(
      container.querySelector(
        '[aria-label="コスモス株式会社/別プロジェクト/契約書を配置先に選択"]',
      ),
    ).toBeNull();
    await search('存在しない');
    expect(container.textContent).toContain('一致するフォルダーはありません');
    expect(apply).not.toHaveBeenCalled();
  });
  it('blocks changes while busy, with no selected files, or after a destination is removed', async () => {
    await render();
    await click('コスモス株式会社/ABCプロジェクト/契約書を配置先に選択');
    await render({ disabled: true });
    await click('選択した3件の配置先に指定');
    expect(apply).not.toHaveBeenCalled();
    await render({ count: 0 });
    expect(button('選択した0件の配置先に指定').disabled).toBe(true);
    expect(button('配置先を未選択に戻す').disabled).toBe(true);
    await render({ destinations: destinations.filter((d) => d.key !== 'a') });
    expect(button('選択した3件の配置先に指定').disabled).toBe(true);
    await render();
    await click('配置先を未選択に戻す');
    expect(apply).toHaveBeenLastCalledWith('');
  });
});
