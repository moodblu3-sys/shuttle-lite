import type { ItemState, JobState } from '@shuttle-lite/core';

const ITEM_TONE: Record<string, string> = {
  COMPLETED: 'ok',
  SKIPPED: 'ghost',
  FAILED: 'bad',
  NEEDS_REVIEW: 'warn',
  REVIEW_REQUIRED: 'wait',
  RETRY_WAIT: 'warn',
  UNKNOWN_OUTCOME: 'warn',
  PAUSED: 'ghost',
};

export function StatePill({ state }: { state: ItemState | JobState | string }) {
  const tone = ITEM_TONE[state] ?? 'run';
  return <span className={`pill ${tone}`}>{state}</span>;
}
