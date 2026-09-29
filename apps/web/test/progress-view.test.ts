// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobSnapshot } from '@shuttle-lite/telemetry';
import { ProgressView } from '../src/components/progress-view';

const navigate = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: navigate }) }));

function snapshot(patch: Partial<JobSnapshot> = {}): JobSnapshot {
  return {
    job: {
      migrationMode: 'AI_ORGANIZE',
      transferMode: 'STAGED',
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
    navigate.mockClear();
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
    expect(container.querySelectorAll('a[href$="format=json"]')).toHaveLength(0);
    expect(container.querySelector('.job-ids')).toBeNull();
    const transfer = [...container.querySelectorAll('details')].find(
      (d) => d.querySelector('summary')?.textContent === '転送の詳細',
    )!;
    expect(transfer.open).toBe(false);
    expect(transfer.textContent).toContain('Boxへ転送');
  });
  it('presents job failures with collapsed diagnostics and preserves retry controls', async () => {
    const initial = snapshot({ failedItems: 1 });
    await render({
      ...initial,
      job: {
        ...initial.job,
        state: 'FAILED',
        lastErrorCategory: 'PROXY_AUTH',
        lastError: 'HTTP 407 proxy authentication required',
      },
    });
    const alert = container.querySelector('[role=alert]')!;
    const details = alert.querySelector('details')!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain('HTTP 407');
    details.remove();
    expect(alert.textContent).toContain('プロキシの認証に失敗しました');
    expect(alert.textContent).not.toContain('407');
    expect(container.textContent).toContain('失敗した1件を再実行');
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
  it('shows a single verified-progress bar and starts delta checking from the upper-right action', async () => {
    const initial = snapshot();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ eligible: true })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ command: { id: 'check' } }), { status: 202 }),
      );
    vi.stubGlobal('fetch', fetch);
    await render({
      ...initial,
      job: { ...initial.job, migrationMode: 'AS_IS', transferMode: 'FINAL' },
    });
    expect(container.querySelectorAll('.track')).toHaveLength(1);
    expect(container.querySelector('.track')?.textContent).toContain('移行の進捗');
    expect(container.textContent).not.toContain('最終フォルダーへ配置');
    const button = container.querySelector<HTMLButtonElement>('.job-head-action button')!;
    expect(button.textContent).toBe('差分を確認');
    await act(async () => {
      button.click();
      button.click();
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetch.mock.calls[1]![1].body).type).toBe('CHECK_DELTA');
    expect(navigate).toHaveBeenCalledWith('/jobs/job/delta');
  });

  it('does not count transferred but unverified files as complete or offer delta for test runs', async () => {
    const initial = snapshot({ completedItems: 2, transferredItems: 5 });
    await render({
      ...initial,
      job: { ...initial.job, state: 'RUNNING', migrationMode: 'AS_IS', transferMode: 'FINAL' },
    });
    expect(container.querySelector<HTMLElement>('.bar-done')!.style.width).toBe('40%');
    expect(container.querySelector('.job-head-action')).toBeNull();
    await render({ ...initial, job: { ...initial.job, migrationMode: 'AS_IS', testMode: true } });
    expect(container.querySelector('.job-head-action')).toBeNull();
  });

  it('shows a recoverable error when delta submission returns an empty response', async () => {
    const initial = snapshot();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ eligible: true })))
        .mockResolvedValueOnce(new Response('', { status: 503 })),
    );
    await render({ ...initial, job: { ...initial.job, migrationMode: 'AS_IS' } });
    await act(async () =>
      container.querySelector<HTMLButtonElement>('.job-head-action button')!.click(),
    );
    expect(container.querySelector('.job-head-action [role=alert]')?.textContent).toContain(
      '差分確認を開始できませんでした',
    );
    expect(navigate).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLButtonElement>('.job-head-action button')!.disabled).toBe(
      false,
    );
  });
});
