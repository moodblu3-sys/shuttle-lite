import { describe, expect, it } from 'vitest';
import type { JobCommandRecord, MigrationJob } from '@shuttle-lite/core';
import { decideNextAction } from '@shuttle-lite/telemetry';

function job(state: MigrationJob['state']): MigrationJob {
  return {
    id: 'job_1',
    testMode: false,
    cleanupState: 'NONE',
    cleanupMessage: null,
    name: 'テスト移行',
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
  completedItems: 0,
  skippedItems: 0,
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
    expect(
      decideNextAction({ ...base, job: job('COMPLETED'), processedItems: 10, completedItems: 10 })
        .kind,
    ).toBe('REPORT');
  });
});

describe('accurate completion messages', () => {
  it.each([
    [0, 10],
    [7, 3],
  ])('distinguishes %i completed and %i skipped files', (completedItems, skippedItems) => {
    const action = decideNextAction({
      ...base,
      job: job('COMPLETED'),
      processedItems: 10,
      completedItems,
      skippedItems,
    });
    expect(action.kind).toBe('REPORT');
    expect(action.message).toContain(`完了 ${completedItems}件・スキップ ${skippedItems}件`);
    expect(action.message).not.toContain('全件');
  });
  it('reports an empty completed job without calling it pending', () => {
    expect(decideNextAction({ ...base, job: job('COMPLETED'), totalItems: 0 })).toEqual({
      kind: 'REPORT',
      message: '対象のファイルがありませんでした。',
    });
    expect(decideNextAction({ ...base, job: job('SCANNING'), totalItems: 0 }).kind).toBe('WORKING');
  });
  it('still shows failures when skipped and failed items are terminal', () => {
    expect(
      decideNextAction({
        ...base,
        job: job('COMPLETED'),
        processedItems: 10,
        failedItems: 2,
        skippedItems: 8,
      }).kind,
    ).toBe('RETRY_FAILED');
  });
  it.each(['PENDING', 'CLAIMED'] as const)(
    'waits for a %s start instead of inviting duplicate starts',
    (state) => {
      const command: JobCommandRecord = {
        id: 'cmd_start',
        jobId: 'job_1',
        type: 'START_JOB',
        payload: {},
        state,
        createdAt: '2026-09-22T00:00:00.000Z',
        claimedAt: null,
        completedAt: null,
        rejectionReason: null,
      };
      const commands: JobCommandRecord[] = [
        { ...command, id: 'cmd_report', type: 'GENERATE_REPORT' },
        command,
      ];
      expect(decideNextAction({ ...base, job: job('QUEUED'), commands }).message).toBe(
        '開始待ちです。',
      );
      expect(
        decideNextAction({
          ...base,
          job: job('PAUSED'),
          commands: [{ ...command, type: 'RESUME_JOB' }],
        }).message,
      ).toBe('再開待ちです。');
    },
  );
});
