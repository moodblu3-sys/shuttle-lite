// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MetadataSettings } from '../src/components/metadata-settings';

const templates = ['契約書管理', '請求書管理', '議事録管理'].map((displayName, index) => ({
  scope: 'enterprise_123',
  templateKey: `template${index}`,
  displayName,
  fields: [],
}));

describe('multiple enabled templates settings', () => {
  let root: Root;
  let container: HTMLDivElement;
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  it('loads previous selections and saves any combination of three templates', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        templates,
        revision: 4,
        mappings: [{ documentType: '契約書', template: templates[0] }],
      }),
    );
    await act(async () => root.render(createElement(MetadataSettings)));
    const boxes = [...container.querySelectorAll<HTMLInputElement>('input[type=checkbox]')];
    expect(boxes).toHaveLength(3);
    expect(boxes[0]!.checked).toBe(true);
    expect(container.querySelector('select')).toBeNull();
    await act(async () => {
      boxes[1]!.click();
      boxes[2]!.click();
    });
    fetchMock.mockResolvedValueOnce(Response.json({ revision: 5 }));
    await act(async () => container.querySelector('button')!.click());
    expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string)).toEqual({
      revision: 4,
      templates: templates.map(({ scope, templateKey }) => ({ scope, templateKey })),
    });
    expect(container.textContent).toContain('保存しました');
  });
  it('reports a save failure without losing selected templates', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ templates, revision: 0, mappings: [] }));
    await act(async () => root.render(createElement(MetadataSettings)));
    await act(async () => container.querySelector<HTMLInputElement>('input')!.click());
    fetchMock.mockResolvedValueOnce(Response.json({ error: '取得できません' }, { status: 400 }));
    await act(async () => container.querySelector('button')!.click());
    expect(container.querySelector<HTMLInputElement>('input')!.checked).toBe(true);
    expect(container.querySelector('[role=alert]')?.textContent).toBe('取得できません');
  });
});
