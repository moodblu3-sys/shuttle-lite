import {
  isPipelineState,
  type ItemState,
  type Phase,
  PHASES,
  phaseForState,
  PIPELINE_STATES,
  pipelineProgress,
} from './state';

export interface PhaseCounters {
  readonly phase: Phase;
  readonly pending: number;
  readonly active: number;
  readonly done: number;
  readonly failed: number;
}

export interface ThroughputSample {
  readonly bytes: number;
  readonly at: number;
}

/**
 * Bytes per second over the sample window. Uploads stall and resume, so a
 * windowed rate is more honest than total bytes over total elapsed time.
 */
export function throughputBytesPerSecond(samples: readonly ThroughputSample[]): number {
  if (samples.length < 2) return 0;
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (!first || !last) return 0;
  const elapsedMs = last.at - first.at;
  if (elapsedMs <= 0) return 0;
  const delta = last.bytes - first.bytes;
  if (delta <= 0) return 0;
  return (delta / elapsedMs) * 1000;
}

export function etaSeconds(remainingBytes: number, bytesPerSecond: number): number | null {
  if (remainingBytes <= 0) return 0;
  if (bytesPerSecond <= 0) return null;
  return Math.round(remainingBytes / bytesPerSecond);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : value < 10 ? 2 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null) return '算出中';
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}分${rest.toString().padStart(2, '0')}秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours}時間${(minutes % 60).toString().padStart(2, '0')}分`;
}

/**
 * Short enough to fit one line in the phase stepper. The long English labels
 * wrapped and broke the row alignment.
 */
export const PHASE_LABELS: Record<Phase, string> = {
  SCAN: 'Scan',
  PREFLIGHT: 'Preflight',
  UPLOAD: 'Upload',
  TRANSFER_VERIFY: '転送検証',
  METADATA: 'Metadata',
  AI_EXTRACTION: 'AI抽出',
  REVIEW: '承認',
  MOVE: '配置',
  FINAL_VERIFY: '最終検証',
  TELEMETRY: 'Snowflake配信',
};

export function emptyPhaseCounters(): PhaseCounters[] {
  return PHASES.map((phase) => ({ phase, pending: 0, active: 0, done: 0, failed: 0 }));
}

const PHASE_RANGE = new Map<Phase, { min: number; max: number }>();
for (const [index, state] of PIPELINE_STATES.entries()) {
  const phase = phaseForState(state);
  const range = PHASE_RANGE.get(phase);
  PHASE_RANGE.set(
    phase,
    range
      ? { min: Math.min(range.min, index), max: Math.max(range.max, index) }
      : { min: index, max: index },
  );
}

export interface PhaseCountable {
  readonly count?: number;
  readonly state: ItemState;
  readonly resumeState: ItemState | null;
}

/**
 * Projects items onto the phase list the UI shows. Upload progress and AI
 * progress are reported separately so that a review backlog is never mistaken
 * for a transfer failure (docs/requirements.md 4.13).
 */
export function buildPhaseCounters(items: readonly PhaseCountable[]): PhaseCounters[] {
  const counters = new Map<
    Phase,
    { pending: number; active: number; done: number; failed: number }
  >(PHASES.map((phase) => [phase, { pending: 0, active: 0, done: 0, failed: 0 }]));

  for (const item of items) {
    const progress = pipelineProgress(item.state, item.resumeState);
    const effective = isPipelineState(item.state) ? item.state : item.resumeState;
    const currentPhase = effective && isPipelineState(effective) ? phaseForState(effective) : null;
    const failed = item.state === 'FAILED';

    for (const phase of PHASES) {
      const bucket = counters.get(phase);
      const range = PHASE_RANGE.get(phase);
      if (!bucket) continue;
      if (phase === 'TELEMETRY' || !range) continue;
      if (item.state === 'COMPLETED' || progress > range.max) {
        bucket.done += item.count ?? 1;
      } else if (currentPhase === phase) {
        if (failed) bucket.failed += item.count ?? 1;
        else bucket.active += item.count ?? 1;
      } else {
        bucket.pending += item.count ?? 1;
      }
    }
  }

  return PHASES.map((phase) => ({
    phase,
    ...(counters.get(phase) ?? { pending: 0, active: 0, done: 0, failed: 0 }),
  }));
}
