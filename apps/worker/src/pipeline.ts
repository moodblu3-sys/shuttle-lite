import {
  decideRetry,
  DEFAULT_BACKOFF,
  isPipelineState,
  type ItemState,
  type MigrationItem,
  phaseForState,
  toShuttleError,
} from '@shuttle-lite/core';
import type { JobContext } from './context';
import { placeItem, finalVerify } from './steps/placement';
import { runRouting } from './steps/routing';
import {
  applyProvenance,
  hashItem,
  preflightItem,
  uploadItem,
  verifyTransfer,
} from './steps/transfer';

export const TRANSFER_SCOPE: readonly ItemState[] = [
  'DISCOVERED',
  'HASHING',
  'PREFLIGHT',
  'READY',
  'UPLOADING',
  'STAGED',
  'TRANSFER_VERIFIED',
  'PROVENANCE_PENDING',
];

export const ROUTING_SCOPE: readonly ItemState[] = ['PROVENANCE_APPLIED', 'AI_PENDING'];

export const PLACEMENT_SCOPE: readonly ItemState[] = ['APPROVED', 'MOVING', 'FINAL_VERIFY'];

type Step = (ctx: JobContext, item: MigrationItem) => Promise<void>;

const STEPS: Partial<Record<ItemState, Step>> = {
  DISCOVERED: hashItem,
  HASHING: hashItem,
  PREFLIGHT: preflightItem,
  READY: uploadItem,
  UPLOADING: uploadItem,
  STAGED: verifyTransfer,
  TRANSFER_VERIFIED: applyProvenance,
  PROVENANCE_PENDING: applyProvenance,
  PROVENANCE_APPLIED: runRouting,
  AI_PENDING: runRouting,
  APPROVED: placeItem,
  MOVING: finalVerify,
  FINAL_VERIFY: finalVerify,
};

export type AdvanceResult = 'ADVANCED' | 'OUT_OF_SCOPE' | 'BLOCKED';

/**
 * Resolves which pipeline state an item should execute. A side state carries
 * the state to resume from, so a retry re-runs exactly the step that failed.
 */
function effectiveState(item: MigrationItem): ItemState | null {
  if (isPipelineState(item.state)) return item.state;
  if (item.state === 'RETRY_WAIT' || item.state === 'UNKNOWN_OUTCOME') return item.resumeState;
  return null;
}

/**
 * Runs one step of the pipeline for one item, and converts any failure into a
 * classified retry, a review item or a terminal failure.
 */
export async function advanceItem(
  ctx: JobContext,
  itemId: string,
  scope: readonly ItemState[],
): Promise<AdvanceResult> {
  if (ctx.store.getJob(ctx.job.id)?.cleanupState !== 'NONE') return 'BLOCKED';
  const stored = ctx.store.getItem(itemId);
  if (!stored) return 'OUT_OF_SCOPE';
  const state = effectiveState(stored);
  if (!state || !scope.includes(state)) return 'OUT_OF_SCOPE';

  const step = STEPS[state];
  if (!step) return 'OUT_OF_SCOPE';

  // Resuming: bring the row back into the pipeline state before working on it.
  const item =
    stored.state === state
      ? stored
      : ctx.store.transitionItem({
          itemId,
          to: state,
          telemetry: ctx.telemetry,
          patch: { resumeState: null },
        });

  try {
    await step(ctx, item);
    // Retry budget is per step, not per item lifetime. Without this reset a
    // file that needed two retries during upload would start the AI step with
    // fewer attempts left than a file that uploaded cleanly.
    const advanced = ctx.store.getItem(itemId);
    if (advanced && advanced.state !== state && advanced.attempts > 0) {
      ctx.store.updateItem(itemId, { attempts: 0 });
    }
    return 'ADVANCED';
  } catch (error) {
    await handleStepFailure(ctx, item, state, error);
    return 'BLOCKED';
  }
}

async function handleStepFailure(
  ctx: JobContext,
  item: MigrationItem,
  state: ItemState,
  error: unknown,
): Promise<void> {
  const shuttleError = toShuttleError(error);
  const attempt = item.attempts + 1;
  const decision = decideRetry({
    category: shuttleError.category,
    attempt,
    retryAfterMs: shuttleError.retryAfterMs,
    policy: { ...DEFAULT_BACKOFF, maxAttempts: ctx.config.limits.maxAttempts },
  });
  const phase = phaseForState(state);

  ctx.logger.warn('step failed', {
    itemId: item.id,
    state,
    category: shuttleError.category,
    attempt,
    decision: decision.action,
    requestId: shuttleError.requestId,
    message: shuttleError.message,
  });

  if (decision.action === 'RETRY') {
    // An unknown remote outcome has to be reconciled against Box before the
    // step runs again, so it parks in a different state.
    const to = shuttleError.needsReconcile ? 'UNKNOWN_OUTCOME' : 'RETRY_WAIT';
    ctx.store.transitionItem({
      itemId: item.id,
      to,
      telemetry: ctx.telemetry,
      patch: {
        resumeState: state,
        attempts: attempt,
        retryCount: item.retryCount + 1,
        nextAttemptAt: new Date(Date.now() + decision.delayMs).toISOString(),
        lastErrorCategory: shuttleError.category,
        lastError: shuttleError.message,
      },
      event: {
        status: 'RETRYING',
        phase,
        errorCategory: shuttleError.category,
        retryCount: item.retryCount + 1,
        boxFileId: item.boxFileId,
        message: `${shuttleError.message} (次回 ${decision.delayMs}ms 後)`,
      },
    });
    return;
  }

  if (decision.action === 'NEEDS_REVIEW') {
    // Give the operator something to act on: the reason is recorded as the
    // routing suggestion so the review screen can offer manual input.
    ctx.store.upsertSuggestion({
      itemId: item.id,
      suggestedDestinationKey: ctx.store.getRouting(item.id)?.suggestedDestinationKey ?? null,
      suggestionSource: 'FALLBACK',
      suggestionReason: `${shuttleError.operatorAction} (${shuttleError.category}: ${shuttleError.message})`,
      state: 'NEEDS_INPUT',
    });
    ctx.store.transitionItem({
      itemId: item.id,
      to: 'NEEDS_REVIEW',
      telemetry: ctx.telemetry,
      patch: {
        resumeState: state,
        attempts: attempt,
        lastErrorCategory: shuttleError.category,
        lastError: shuttleError.message,
        nextAttemptAt: null,
      },
      event: {
        status: 'FAILED',
        phase,
        errorCategory: shuttleError.category,
        boxFileId: item.boxFileId,
        message: shuttleError.message,
      },
    });
    return;
  }

  ctx.store.transitionItem({
    itemId: item.id,
    to: 'FAILED',
    telemetry: ctx.telemetry,
    patch: {
      resumeState: state,
      attempts: attempt,
      lastErrorCategory: shuttleError.category,
      lastError: shuttleError.message,
      nextAttemptAt: null,
    },
    event: {
      status: 'FAILED',
      phase,
      errorCategory: shuttleError.category,
      boxFileId: item.boxFileId,
      message: shuttleError.message,
    },
  });
}
