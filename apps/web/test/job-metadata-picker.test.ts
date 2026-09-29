// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BusinessTemplate } from '@shuttle-lite/core';
import { JobMetadataPicker } from '../src/components/job-metadata-picker';

const templates: BusinessTemplate[] = ['契約書管理', '請求書管理', '議事録管理'].map(
  (displayName, index) => ({
    scope: 'enterprise_123',
    templateKey: `template${index}`,
    displayName,
    fields: [{ key: 'title', displayName: '件名', type: 'string' }],
  }),
);

describe('per-migration metadata picker', () => {
  let root: Root;
  let container: HTMLDivElement;
  const fetchMock = vi.fn<typeof fetch>();
  function Form() {
    const [selected, setSelected] = useState<BusinessTemplate[]>([]);
    return createElement(JobMetadataPicker, { selected, onChange: setSelected, disabled: false });
  }
  beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(createElement(Form)));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  async function open() {
    await act(async () => {
      const details = container.querySelector('details')!;
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
    });
  }
  it('loads on expansion, starts unchecked, and selects only checked templates without a separate save', async () => {
    expect(container.querySelector('details')!.open).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValue(
      Response.json({ templates, mappings: [{ template: templates[0] }], revision: 2 }),
    );
    await open();
    const boxes = [...container.querySelectorAll<HTMLInputElement>('input[type=checkbox]')];
    expect(boxes).toHaveLength(3);
    expect(boxes.every((box) => !box.checked)).toBe(true);
    await act(async () => boxes[0]!.click());
    await act(async () => boxes[2]!.click());
    expect(boxes.map((box) => box.checked)).toEqual([true, false, true]);
    expect(container.querySelector('summary')?.textContent).toBe('使用するメタデータ2件');
    await act(async () => boxes[0]!.click());
    expect(container.querySelector('summary')?.textContent).toBe('使用するメタデータ1件');
    expect(container.querySelector('button')).toBeNull();
    expect(
      fetchMock.mock.calls.every(([, options]) => !options?.method || options.method === 'GET'),
    ).toBe(true);
  });
  it('allows retrying a failed list fetch', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: '取得できません' }, { status: 502 }));
    await open();
    expect(container.querySelector('[role=alert]')?.textContent).toBe('取得できません');
    fetchMock.mockResolvedValue(Response.json({ templates }));
    await act(async () => container.querySelector('button')!.click());
    expect(container.querySelector('[role=alert]')).toBeNull();
    expect(container.querySelectorAll('input')).toHaveLength(3);
  });
  it('shows an empty list without applying old shared selections', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ templates: [], mappings: [{ template: templates[0] }] }),
    );
    await open();
    expect(container.textContent).toContain('利用できるテンプレートがありません');
    expect(container.querySelector('input')).toBeNull();
  });
});
