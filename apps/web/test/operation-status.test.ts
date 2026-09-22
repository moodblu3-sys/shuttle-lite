import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildJobSnapshot } from '@shuttle-lite/telemetry';
import { createHarness, type Harness } from '../../../test/harness';
import { processCommands } from '../../worker/src/commands';
import { JobControls, OperationResult } from '../src/components/job-controls';
import { ProgressView } from '../src/components/progress-view';
import { POST } from '../src/app/api/jobs/[jobId]/commands/route';
import { getStore } from '../src/lib/runtime';

vi.mock('../src/lib/runtime', () => ({ getStore: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
let h: Harness;
let jobId: string;
beforeEach(async () => {
  h = await createHarness();
  jobId = h.store.createJob({ profileId: h.createProfile().id, operatorLabel: 'tester' }).id;
  vi.mocked(getStore).mockReturnValue(h.store);
});
afterEach(() => h.cleanup());
const snapshot = () => buildJobSnapshot(h.store, jobId)!;
const page = () =>
  renderToStaticMarkup(createElement(ProgressView, { jobId, initial: snapshot(), profile: null }));

describe('live operation feedback', () => {
  it('uses the same snapshot for the header, error and progress state', () => {
    h.store.setJobState(jobId, 'FAILED', {
      lastError: 'synthetic old error',
      lastErrorCategory: 'BOX_SERVER',
    });
    const before = page();
    expect(before).toContain('synthetic old error');
    expect(before).toContain('role="alert"');
    h.store.setJobState(jobId, 'RUNNING', { lastError: null, lastErrorCategory: null });
    const after = page();
    expect(after).toContain('実行中');
    expect(after).not.toContain('synthetic old error');
    expect(after).not.toContain('全件転送済み');
  });

  it('shows an empty completed job as no files, including its header', () => {
    h.store.setJobState(jobId, 'COMPLETED');
    const html = page();
    expect(html).toContain('終了（対象なし）');
    expect(html).toContain('対象のファイルがありませんでした');
    expect(html).not.toContain('全件転送済み');
  });

  it('disables duplicate actions while accepted or running, including after a reload', () => {
    h.store.enqueueCommand(jobId, 'START_JOB');
    for (const claimed of [false, true]) {
      if (claimed) h.store.claimCommands();
      const current = snapshot();
      const html = renderToStaticMarkup(createElement(JobControls, { jobId, snapshot: current }));
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*>この移行を開始する/);
      expect(html).toContain(claimed ? '移行開始を実行中です' : '移行開始を受け付けました');
      expect(page()).toContain('開始待ち');
    }
  });

  it('shows report rejection and its reason instead of a success acknowledgement', () => {
    const command = h.store.enqueueCommand(jobId, 'GENERATE_REPORT');
    h.store.rejectCommand(command.id, 'レポートのBox保存を確認できませんでした（CSV）。');
    const html = renderToStaticMarkup(
      createElement(OperationResult, { command: snapshot().commands[0]! }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('CSV');
    expect(html).not.toContain('Boxに保存しました');
    h.store.completeCommand(command.id);
    const success = renderToStaticMarkup(
      createElement(OperationResult, { command: snapshot().commands[0]! }),
    );
    expect(success).toContain('レポートをBoxに保存しました');
  });
});

describe('command submission', () => {
  const submit = (body: unknown) =>
    POST(
      new Request('http://localhost/api/jobs/example/commands', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ jobId }) },
    );

  it('returns the existing active operation on repeated submissions but allows retry after failure', async () => {
    const first = await (await submit({ type: 'START_JOB' })).json();
    const duplicate = await (await submit({ type: 'START_JOB' })).json();
    expect(duplicate.command.id).toBe(first.command.id);
    h.store.claimCommands();
    const claimedDuplicate = await (await submit({ type: 'START_JOB' })).json();
    expect(claimedDuplicate.command.id).toBe(first.command.id);
    h.store.rejectCommand(first.command.id, 'synthetic interruption');
    const retry = await (await submit({ type: 'START_JOB' })).json();
    expect(retry.command.id).not.toBe(first.command.id);
    await processCommands(h.ctx);
    expect(snapshot().commands[0]?.state).toBe('DONE');
  });

  it.each([null, [], { type: 'UNKNOWN' }])('rejects malformed command input: %j', async (input) => {
    expect((await submit(input)).status).toBe(400);
    expect(h.store.listCommands(jobId)).toHaveLength(0);
  });
});
