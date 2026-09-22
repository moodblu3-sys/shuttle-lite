import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { approveItem, createHarness, runUntilIdle, type Harness } from './harness';

const CONTRACT = ['業務委託契約書', '契約番号: LEG-2026-0042', '発効日 2026-04-01'].join('\n');

describe('job scheduling', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(() => {
    harness.cleanup();
  });

  it('does not let a job waiting for review starve the next job', async () => {
    harness.writeSource('legal/first.txt', CONTRACT);
    const profile = harness.createProfile();
    const first = harness.store.createJob({ profileId: profile.id, operatorLabel: 'tester' });
    harness.store.enqueueCommand(first.id, 'START_JOB');
    await runUntilIdle(harness);
    expect(harness.store.listItems(first.id)[0]?.state).toBe('REVIEW_REQUIRED');

    // A second job created while the first one waits for a human decision.
    harness.writeSource('finance/second.txt', `${CONTRACT}\nsecond`);
    const second = harness.store.createJob({ profileId: profile.id, operatorLabel: 'tester' });
    harness.store.enqueueCommand(second.id, 'START_JOB');
    await runUntilIdle(harness);

    const secondItems = harness.store.listItems(second.id);
    expect(secondItems.length).toBeGreaterThan(0);
    expect(secondItems.every((item) => item.state === 'REVIEW_REQUIRED')).toBe(true);
    // The first job is untouched and still waiting.
    expect(harness.store.listItems(first.id)[0]?.state).toBe('REVIEW_REQUIRED');
  });

  it('picks a job back up as soon as an approval command arrives', async () => {
    harness.writeSource('legal/first.txt', CONTRACT);
    const profile = harness.createProfile();
    const job = harness.store.createJob({ profileId: profile.id, operatorLabel: 'tester' });
    harness.store.enqueueCommand(job.id, 'START_JOB');
    await runUntilIdle(harness);

    const item = harness.store.listItems(job.id)[0]!;
    approveItem(harness, item, 'LEGAL_CONTRACTS');
    await runUntilIdle(harness);

    expect(harness.store.getItem(item.id)?.state).toBe('COMPLETED');
    expect(harness.store.getJob(job.id)?.state).toBe('COMPLETED');
  });

  it('completes a job whose source root has no files', async () => {
    const profile = harness.createProfile();
    const job = harness.store.createJob({ profileId: profile.id, operatorLabel: 'tester' });
    harness.store.enqueueCommand(job.id, 'START_JOB');

    await runUntilIdle(harness);

    expect(harness.store.getJob(job.id)?.state).toBe('COMPLETED');
    expect(harness.store.listItems(job.id)).toHaveLength(0);
  });

  it('leaves a paused job alone and does not block others', async () => {
    harness.writeSource('legal/first.txt', CONTRACT);
    const profile = harness.createProfile();
    const paused = harness.store.createJob({ profileId: profile.id, operatorLabel: 'tester' });
    harness.store.enqueueCommand(paused.id, 'PAUSE_JOB');
    harness.store.enqueueCommand(paused.id, 'START_JOB');
    await runUntilIdle(harness);

    const other = harness.store.createJob({ profileId: profile.id, operatorLabel: 'tester' });
    harness.store.enqueueCommand(other.id, 'START_JOB');
    await runUntilIdle(harness);

    expect(harness.store.listItems(other.id).length).toBeGreaterThan(0);
  });
});
