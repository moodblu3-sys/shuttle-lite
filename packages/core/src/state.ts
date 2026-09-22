/**
 * Item state model from docs/architecture.md section 7.
 *
 * The pipeline states are linear. The side states are entered from a pipeline
 * state and remember where to continue from in `resumeState`, so that a
 * restart or an operator retry never has to guess the next step.
 */

export const PIPELINE_STATES = [
  'DISCOVERED',
  'HASHING',
  'PREFLIGHT',
  'READY',
  'UPLOADING',
  'STAGED',
  'TRANSFER_VERIFIED',
  'PROVENANCE_PENDING',
  'PROVENANCE_APPLIED',
  'AI_PENDING',
  'AI_COMPLETED',
  'REVIEW_REQUIRED',
  'APPROVED',
  'MOVING',
  'FINAL_VERIFY',
  'COMPLETED',
] as const;

export const SIDE_STATES = [
  'PAUSED',
  'RETRY_WAIT',
  'UNKNOWN_OUTCOME',
  'NEEDS_REVIEW',
  'SKIPPED',
  'FAILED',
] as const;

export type PipelineState = (typeof PIPELINE_STATES)[number];
export type SideState = (typeof SIDE_STATES)[number];
export type ItemState = PipelineState | SideState;

export const ITEM_STATES: readonly ItemState[] = [...PIPELINE_STATES, ...SIDE_STATES];

const PIPELINE_INDEX = new Map<ItemState, number>(PIPELINE_STATES.map((s, i) => [s, i]));

export function isPipelineState(state: ItemState): state is PipelineState {
  return PIPELINE_INDEX.has(state);
}

export function isSideState(state: ItemState): state is SideState {
  return !PIPELINE_INDEX.has(state);
}

/** COMPLETED, SKIPPED and FAILED are the only states a job may finish on. */
export function isTerminal(state: ItemState): boolean {
  return state === 'COMPLETED' || state === 'SKIPPED' || state === 'FAILED';
}

/**
 * States the worker may pick up on its own. REVIEW_REQUIRED and NEEDS_REVIEW
 * wait for an operator command, and APPROVED is only reached through one.
 */
export function isWorkable(state: ItemState): boolean {
  return isPipelineState(state) && state !== 'COMPLETED' && state !== 'REVIEW_REQUIRED';
}

const NEXT_PIPELINE: Record<PipelineState, PipelineState | null> = {
  DISCOVERED: 'HASHING',
  HASHING: 'PREFLIGHT',
  PREFLIGHT: 'READY',
  READY: 'UPLOADING',
  UPLOADING: 'STAGED',
  STAGED: 'TRANSFER_VERIFIED',
  TRANSFER_VERIFIED: 'PROVENANCE_PENDING',
  PROVENANCE_PENDING: 'PROVENANCE_APPLIED',
  PROVENANCE_APPLIED: 'AI_PENDING',
  AI_PENDING: 'AI_COMPLETED',
  AI_COMPLETED: 'REVIEW_REQUIRED',
  REVIEW_REQUIRED: 'APPROVED',
  APPROVED: 'MOVING',
  MOVING: 'FINAL_VERIFY',
  FINAL_VERIFY: 'COMPLETED',
  COMPLETED: null,
};

export function nextPipelineState(state: PipelineState): PipelineState | null {
  return NEXT_PIPELINE[state];
}

/**
 * Allowed transitions. Every pipeline state may additionally go to a side
 * state, and side states may return to the pipeline state they came from.
 */
const EXTRA_TRANSITIONS: Partial<Record<ItemState, readonly ItemState[]>> = {
  // AI can be skipped entirely when routing is disabled or unsupported.
  PROVENANCE_APPLIED: ['AI_PENDING', 'REVIEW_REQUIRED'],
  AI_PENDING: ['AI_COMPLETED', 'REVIEW_REQUIRED'],
  // A stale approval sends the item back for another human decision.
  APPROVED: ['MOVING', 'REVIEW_REQUIRED'],
  MOVING: ['FINAL_VERIFY', 'REVIEW_REQUIRED'],
  FINAL_VERIFY: ['COMPLETED', 'REVIEW_REQUIRED'],
  NEEDS_REVIEW: ['REVIEW_REQUIRED', 'APPROVED', 'SKIPPED', 'FAILED'],
  REVIEW_REQUIRED: ['APPROVED', 'NEEDS_REVIEW', 'SKIPPED'],
};

const SIDE_ENTRY: readonly SideState[] = [
  'PAUSED',
  'RETRY_WAIT',
  'UNKNOWN_OUTCOME',
  'NEEDS_REVIEW',
  'SKIPPED',
  'FAILED',
];

export function allowedTransitions(from: ItemState): readonly ItemState[] {
  const allowed = new Set<ItemState>();
  if (isPipelineState(from)) {
    const next = NEXT_PIPELINE[from];
    if (next) allowed.add(next);
    for (const s of SIDE_ENTRY) allowed.add(s);
  }
  if (from === 'PAUSED' || from === 'RETRY_WAIT' || from === 'UNKNOWN_OUTCOME') {
    for (const s of PIPELINE_STATES) allowed.add(s);
    allowed.add('FAILED');
    allowed.add('SKIPPED');
    allowed.add('NEEDS_REVIEW');
  }
  // An operator retry may send a failed or parked item back to any earlier
  // step, which is how "failed phaseから再実行" works.
  if (from === 'FAILED' || from === 'NEEDS_REVIEW') {
    for (const s of PIPELINE_STATES) allowed.add(s);
    allowed.add('SKIPPED');
    allowed.add('FAILED');
    allowed.add('NEEDS_REVIEW');
  }
  for (const s of EXTRA_TRANSITIONS[from] ?? []) allowed.add(s);
  allowed.delete(from);
  return [...allowed];
}

export function canTransition(from: ItemState, to: ItemState): boolean {
  if (from === to) return true;
  return allowedTransitions(from).includes(to);
}

/** Progress phases from docs/requirements.md section 4.13. */
export const PHASES = [
  'SCAN',
  'PREFLIGHT',
  'UPLOAD',
  'TRANSFER_VERIFY',
  'METADATA',
  'AI_EXTRACTION',
  'REVIEW',
  'MOVE',
  'FINAL_VERIFY',
  'TELEMETRY',
] as const;

export type Phase = (typeof PHASES)[number];

const STATE_PHASE: Record<PipelineState, Phase> = {
  DISCOVERED: 'SCAN',
  HASHING: 'SCAN',
  PREFLIGHT: 'PREFLIGHT',
  READY: 'PREFLIGHT',
  UPLOADING: 'UPLOAD',
  STAGED: 'UPLOAD',
  TRANSFER_VERIFIED: 'TRANSFER_VERIFY',
  PROVENANCE_PENDING: 'METADATA',
  PROVENANCE_APPLIED: 'METADATA',
  AI_PENDING: 'AI_EXTRACTION',
  AI_COMPLETED: 'AI_EXTRACTION',
  REVIEW_REQUIRED: 'REVIEW',
  APPROVED: 'REVIEW',
  MOVING: 'MOVE',
  FINAL_VERIFY: 'FINAL_VERIFY',
  COMPLETED: 'FINAL_VERIFY',
};

export function phaseForState(state: ItemState, resumeState?: ItemState | null): Phase {
  if (isPipelineState(state)) return STATE_PHASE[state];
  if (resumeState && isPipelineState(resumeState)) return STATE_PHASE[resumeState];
  return 'SCAN';
}

/**
 * How far an item has progressed, used for progress counters. Side states
 * report the progress of the pipeline state they will resume from.
 */
export function pipelineProgress(state: ItemState, resumeState?: ItemState | null): number {
  const effective = isPipelineState(state) ? state : resumeState;
  if (effective && isPipelineState(effective)) {
    return PIPELINE_INDEX.get(effective) ?? 0;
  }
  return 0;
}
