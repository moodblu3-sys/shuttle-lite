// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobSnapshot } from '@shuttle-lite/telemetry';
import { ProgressView } from '../src/components/progress-view';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

function snapshot(patch: Partial<JobSnapshot> = {}): JobSnapshot {
  return {
    job: {
      id: 'job',
      name: '9月の書類整理',
      profileId: 'profile',
      state: 'COMPLETED',
      testMode: false,
      cleanupState: 'NONE',
      cleanupMessage: null,
      operatorLabel: '担当者',
      stagingFolderId: 'staging',
      pauseRequested: false,
      leaseOwner: null,
      leaseExpiresAt: null,
      totalItems: 5,
      totalBytes: 500,
      startedAt: '2026-09-23T00:00:00Z',
      finishedAt: '2026-09-23T00:01:00Z',
      createdAt: '2026-09-23T00:00:00Z',
      updatedAt: '2026-09-23T00:01:00Z',
      lastError: null,
      lastErrorCategory: null,
    },
    commands: [],
    counts: { COMPLETED: 5 },
    phases: [],
    totalItems: 5,
    processedItems: 5,
    transferredItems: 5,
    completedItems: 5,
    skippedItems: 0,
    totalBytes: 500,
    transferredBytes: 500,
    throughputBytesPerSecond: 0,
    etaSeconds: null,
    reviewBacklog: 0,
    failedItems: 0,
    working: false,
    workerUnavailable: false,
    nextAction: { kind: 'REPORT', message: '移行完了' },
    outbox: { pending: 0, failed: 0, delivered: 10 },
    errorCategories: [],
    activeItems: [],
    recentEvents: [],
    at: '2026-09-23',
    ...patch,
  };
}

describe('completion and live progress', () => {
  let container: HTMLDivElement;
  let root: Root;
  let stream: { onmessage?: (event: { data: string }) => void; close: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal(
      'EventSource',
      class {
        close = vi.fn();
        constructor() {
          // Keep a handle to the browser event source so tests can deliver SSE snapshots.
          // eslint-disable-next-line @typescript-eslint/no-this-alias
          stream = this;
        }
      },
    );
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    expect(stream.close).toHaveBeenCalled();
    container.remove();
    vi.unstubAllGlobals();
  });
  async function render(
    initial = snapshot(),
    destinationUrl: string | null = 'https://app.box.com/folder/123',
  ) {
    await act(async () =>
      root.render(
        createElement(ProgressView, { jobId: 'job', initial, profile: null, destinationUrl }),
      ),
    );
  }
  it('shows results and reports with processing details collapsed', async () => {
    await render();
    const result = container.querySelector('[aria-label=移行結果]')!;
    expect(result.querySelector('h2')!.textContent).toBe('移行完了');
    expect([...result.querySelectorAll('.metric .value')].map((v) => v.textContent)).toEqual([
      '5',
      '0',
      '0',
    ]);
    expect(result.querySelector('a')!.href).toBe('https://app.box.com/folder/123');
    expect(container.querySelectorAll('a[href$="format=csv"]')).toHaveLength(1);
    const transfer = [...container.querySelectorAll('details')].find(
      (d) => d.querySelector('summary')?.textContent === '転送の詳細',
    )!;
    expect(transfer.open).toBe(false);
    expect(transfer.textContent).toContain('Boxへ転送');
  });
  it.each([
    { completedItems: 3, failedItems: 1, skippedItems: 1 },
    { completedItems: 0, failedItems: 0, skippedItems: 5 },
    { totalItems: 0, completedItems: 0, failedItems: 0, skippedItems: 0 },
  ])('does not present partial or empty results as all successful: %j', async (counts) => {
    await render(snapshot(counts), null);
    const result = container.querySelector('[aria-label=移行結果]')!;
    expect(result.querySelector('h2')!.textContent).not.toBe('移行完了');
    expect(result.textContent).not.toContain('Boxで確認');
    if (counts.failedItems) expect(container.textContent).toContain('失敗した1件を再実行');
  });
  it('transitions via SSE and keeps pending logs and test cleanup visible', async () => {
    const initial = snapshot();
    await render({ ...initial, job: { ...initial.job, state: 'RUNNING' }, working: true });
    expect(container.querySelector('[aria-label=移行結果]')).toBeNull();
    await act(async () =>
      stream.onmessage!({
        data: JSON.stringify(snapshot({ outbox: { pending: 2, failed: 1, delivered: 7 } })),
      }),
    );
    expect(container.querySelector('[aria-label=移行結果]')!.textContent).toContain(
      'ログ記録：待ち 2 件 / 失敗 1 件',
    );
    await act(async () =>
      stream.onmessage!({
        data: JSON.stringify({
          ...initial,
          job: { ...initial.job, testMode: true, cleanupState: 'DONE', cleanupMessage: '削除済み' },
        }),
      }),
    );
    expect(container.querySelector('[aria-label=移行結果]')).toBeNull();
    expect(container.textContent).toContain('テスト終了');
  });
});
