import { describe, expect, it } from 'vitest';
import type { MigrationJob } from '@shuttle-lite/core';
import { decideNextAction } from '@shuttle-lite/telemetry';

function job(state: MigrationJob['state']): MigrationJob {
  return {
    id: 'job_1',
    profileId: 'prf_1',
    state,
    operatorLabel: 'tester',
    stagingFolderId: 'fld1',
    pauseRequested: state === 'PAUSED',
    leaseOwner: null,
    leaseExpiresAt: null,
    totalItems: 10,
    totalBytes: 100,
    startedAt: null,
    finishedAt: null,
    createdAt: '2026-09-14T00:00:00.000Z',
    updatedAt: '2026-09-14T00:00:00.000Z',
    lastError: null,
    lastErrorCategory: null,
  };
}

const base = {
  totalItems: 10,
  reviewBacklog: 0,
  failedItems: 0,
  processedItems: 0,
  working: false,
};

describe('next action', () => {
  it('asks for approval before anything else once items are waiting', () => {
    const action = decideNextAction({
      ...base,
      job: job('RUNNING'),
      reviewBacklog: 4,
      working: true,
    });
    expect(action.kind).toBe('REVIEW');
    expect(action.count).toBe(4);
  });

  it('reports work in progress when nothing needs a human yet', () => {
    expect(decideNextAction({ ...base, job: job('RUNNING'), working: true }).kind).toBe('WORKING');
  });

  it('offers to start a queued job and to resume a paused one', () => {
    expect(decideNextAction({ ...base, job: job('QUEUED') }).kind).toBe('START');
    expect(decideNextAction({ ...base, job: job('PAUSED') }).kind).toBe('RESUME');
  });

  it('surfaces failures only when no work and no review remain', () => {
    expect(decideNextAction({ ...base, job: job('RUNNING'), failedItems: 2 }).kind).toBe(
      'RETRY_FAILED',
    );
    // A failure must not hide the review queue.
    expect(
      decideNextAction({ ...base, job: job('RUNNING'), failedItems: 2, reviewBacklog: 1 }).kind,
    ).toBe('REVIEW');
  });

  it('points at the report once every item reached a terminal state', () => {
    expect(decideNextAction({ ...base, job: job('COMPLETED'), processedItems: 10 }).kind).toBe(
      'REPORT',
    );
  });
});
