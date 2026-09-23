import {
  buildPhaseCounters,
  etaSeconds,
  type ItemState,
  type JobCommandRecord,
  type MigrationEventRecord,
  type MigrationJob,
  type PhaseCounters,
  throughputBytesPerSecond,
  type ThroughputSample,
} from '@shuttle-lite/core';
import type { ShuttleStore } from '@shuttle-lite/db';

export interface ActiveItemView {
  readonly itemId: string;
  readonly sourceRelativePath: string;
  readonly state: ItemState;
  readonly bytesTransferred: number;
  readonly sourceSize: number;
  readonly retryCount: number;
  readonly lastErrorCategory: string | null;
}

export type NextActionKind =
  'START' | 'RESUME' | 'REVIEW' | 'RETRY_FAILED' | 'REPORT' | 'WORKING' | 'IDLE';

export interface NextAction {
  readonly kind: NextActionKind;
  /** One sentence telling the operator what to do now. */
  readonly message: string;
  readonly count?: number;
}

export interface JobSnapshot {
  readonly job: MigrationJob;
  readonly commands: readonly JobCommandRecord[];
  readonly counts: Record<string, number>;
  readonly phases: readonly PhaseCounters[];
  readonly totalItems: number;
  /** Reached a terminal state: COMPLETED, SKIPPED or FAILED. */
  readonly processedItems: number;
  /** Content is in Box and verified, whether or not it is placed yet. */
  readonly transferredItems: number;
  readonly completedItems: number;
  readonly skippedItems: number;
  readonly totalBytes: number;
  readonly transferredBytes: number;
  readonly throughputBytesPerSecond: number;
  readonly etaSeconds: number | null;
  readonly reviewBacklog: number;
  readonly failedItems: number;
  /** True while the worker still has transfer or AI work it can do. */
  readonly working: boolean;
  readonly workerUnavailable: boolean;
  readonly nextAction: NextAction;
  readonly outbox: { pending: number; failed: number; delivered: number };
  readonly errorCategories: ReadonlyArray<{ category: string; count: number }>;
  readonly activeItems: readonly ActiveItemView[];
  readonly recentEvents: readonly MigrationEventRecord[];
  readonly at: string;
}

const TERMINAL: readonly ItemState[] = ['COMPLETED', 'SKIPPED', 'FAILED'];
const REVIEW: readonly ItemState[] = ['REVIEW_REQUIRED', 'NEEDS_REVIEW'];
/** Content already sits in Box staging, verified. Only placement is pending. */
const TRANSFERRED: readonly ItemState[] = [
  'STAGED',
  'TRANSFER_VERIFIED',
  'PROVENANCE_PENDING',
  'PROVENANCE_APPLIED',
  'AI_PENDING',
  'AI_COMPLETED',
  'REVIEW_REQUIRED',
  'NEEDS_REVIEW',
  'APPROVED',
  'MOVING',
  'FINAL_VERIFY',
  'COMPLETED',
];
const ACTIVE: readonly ItemState[] = [
  'DISCOVERED',
  'AI_COMPLETED',
  'HASHING',
  'PREFLIGHT',
  'READY',
  'UPLOADING',
  'STAGED',
  'TRANSFER_VERIFIED',
  'PROVENANCE_PENDING',
  'PROVENANCE_APPLIED',
  'AI_PENDING',
  'APPROVED',
  'MOVING',
  'FINAL_VERIFY',
  'RETRY_WAIT',
  'UNKNOWN_OUTCOME',
];

/** Windowed byte samples per job, so the rate reflects the recent past. */
const samples = new Map<string, ThroughputSample[]>();

function recordSample(jobId: string, bytes: number): ThroughputSample[] {
  const series = samples.get(jobId) ?? [];
  const now = Date.now();
  const last = series.at(-1);
  if (!last || now - last.at > 500) {
    series.push({ bytes, at: now });
    while (series.length > 24) series.shift();
    samples.set(jobId, series);
  }
  return series;
}

/**
 * Everything the progress screen needs, read straight from SQLite. The UI
 * never reads worker logs, so a page reload restores the same view
 * (docs/implementation-plan.md Phase 8).
 */
export function buildJobSnapshot(store: ShuttleStore, jobId: string): JobSnapshot | null {
  const job = store.getJob(jobId);
  if (!job) return null;

  const commands = store.listJobOperations(jobId);
  const counts = store.countItemsByState(jobId);
  const bytes = store.byteTotals(jobId);
  const totalItems = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const series = recordSample(jobId, bytes.transferredBytes);
  const rate = throughputBytesPerSecond(series);

  const sum = (states: readonly ItemState[]) =>
    states.reduce((total, state) => total + (counts[state] ?? 0), 0);
  const processedItems = sum(TERMINAL);
  const reviewBacklog = sum(REVIEW);
  const transferredItems = sum(TRANSFERRED);
  const failedItems = counts.FAILED ?? 0;
  const completedItems = counts.COMPLETED ?? 0;
  const skippedItems = counts.SKIPPED ?? 0;
  const working = sum(ACTIVE) > 0;
  const needsWorker =
    store.hasOutstandingCommands(jobId) ||
    ['REQUESTED', 'RUNNING'].includes(job.cleanupState) ||
    (job.cleanupState === 'NONE' &&
      !job.pauseRequested &&
      (job.state === 'SCANNING' || (job.state === 'RUNNING' && working)));

  return {
    job,
    commands,
    counts,
    phases: buildPhaseCounters(store.countItemsByPhaseState(jobId)),
    totalItems,
    processedItems,
    transferredItems,
    completedItems,
    skippedItems,
    totalBytes: bytes.totalBytes,
    transferredBytes: bytes.transferredBytes,
    throughputBytesPerSecond: rate,
    etaSeconds: etaSeconds(bytes.totalBytes - bytes.transferredBytes, rate),
    reviewBacklog,
    failedItems,
    working,
    workerUnavailable: needsWorker && !store.isWorkerAvailable(),
    nextAction: decideNextAction({
      job,
      totalItems,
      reviewBacklog,
      failedItems,
      processedItems,
      completedItems,
      skippedItems,
      commands,
      working,
    }),
    outbox: store.outboxStatus(jobId),
    errorCategories: store.errorCategoryCounts(jobId),
    activeItems: store.listItems(jobId, { states: ACTIVE, limit: 12 }).map((item) => ({
      itemId: item.id,
      sourceRelativePath: item.sourceRelativePath,
      state: item.state,
      bytesTransferred: item.bytesTransferred,
      sourceSize: item.sourceSize,
      retryCount: item.retryCount,
      lastErrorCategory: item.lastErrorCategory,
    })),
    recentEvents: store.listEvents(jobId, { limit: 25 }),
    at: new Date().toISOString(),
  };
}

/**
 * What the operator should do next. The migration deliberately stops and waits
 * for a human at review, so the UI has to say so instead of looking stalled.
 */
export function decideNextAction(input: {
  job: MigrationJob;
  totalItems: number;
  reviewBacklog: number;
  failedItems: number;
  processedItems: number;
  completedItems: number;
  skippedItems: number;
  commands?: readonly JobCommandRecord[];
  working: boolean;
}): NextAction {
  const {
    job,
    totalItems,
    reviewBacklog,
    failedItems,
    processedItems,
    completedItems,
    skippedItems,
    working,
  } = input;
  const waitingFor = (type: JobCommandRecord['type']) =>
    input.commands?.some(
      (command) =>
        command.type === type && (command.state === 'PENDING' || command.state === 'CLAIMED'),
    );
  if (job.state === 'QUEUED' && waitingFor('START_JOB')) {
    return { kind: 'WORKING', message: '開始待ち' };
  }
  if (job.state === 'PAUSED' && waitingFor('RESUME_JOB')) {
    return { kind: 'WORKING', message: '再開待ち' };
  }

  if (job.state === 'QUEUED') {
    return { kind: 'START', message: '未開始' };
  }
  if (job.state === 'PAUSED') {
    return { kind: 'RESUME', message: '一時停止中' };
  }
  if (job.state === 'SCANNING') return { kind: 'WORKING', message: 'スキャン中' };
  if (job.state === 'COMPLETED' && totalItems === 0)
    return { kind: 'REPORT', message: '対象ファイルなし' };
  if (reviewBacklog > 0) {
    return {
      kind: 'REVIEW',
      count: reviewBacklog,
      message: `承認待ち ${reviewBacklog}件`,
    };
  }
  if (working) {
    return { kind: 'WORKING', message: '処理中' };
  }
  if (failedItems > 0) {
    return {
      kind: 'RETRY_FAILED',
      count: failedItems,
      message: `失敗 ${failedItems}件`,
    };
  }
  if (totalItems > 0 && processedItems === totalItems) {
    return {
      kind: 'REPORT',
      message:
        skippedItems > 0
          ? `完了 ${completedItems}件・スキップ ${skippedItems}件`
          : `配置完了 ${completedItems}件`,
    };
  }
  return { kind: 'IDLE', message: '処理待ち' };
}

export function resetThroughputSamples(jobId?: string): void {
  if (jobId) samples.delete(jobId);
  else samples.clear();
}
