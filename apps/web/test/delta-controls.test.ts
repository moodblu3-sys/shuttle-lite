// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeltaControls } from '../src/components/delta-controls';

describe('差分確認と対象の選択', () => {
  let container: HTMLDivElement;
  let root: Root;
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
  const plan = {
    id: 'plan',
    startedJobId: null,
    folders: [],
    entries: [
      { path: 'A.txt', action: 'UPDATE' },
      { path: 'B.txt', action: 'ADD' },
      { path: 'C.txt', action: 'CONFLICT', reason: '両方で変更' },
    ],
  };
  it('sends only the plan ID and exclusions; conflicts cannot be selected', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ eligible: true, runs: [], commands: [], plan }),
    );
    await act(async () => root.render(createElement(DeltaControls, { jobId: 'job' })));
    const checks = container.querySelectorAll<HTMLInputElement>('input[type=checkbox]');
    expect(checks).toHaveLength(2);
    await act(async () => checks[0]!.click());
    fetchMock.mockResolvedValueOnce(
      Response.json({ command: { id: 'cmd', type: 'START_DELTA', state: 'PENDING' } }),
    );
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((b) => b.textContent === '差分を移行')!
        .click(),
    );
    expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string)).toEqual({
      type: 'START_DELTA',
      payload: { planId: 'plan', excludedPaths: ['A.txt'] },
    });
    expect(container.textContent).toContain('処理中');
  });
  it('disables scanning while a previous execution is active', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ eligible: false, runs: [], commands: [], plan: null }),
    );
    await act(async () => root.render(createElement(DeltaControls, { jobId: 'job' })));
    expect(container.querySelector('button')!.disabled).toBe(true);
  });
});
