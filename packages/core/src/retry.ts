import { ERROR_CATEGORY_META, type ErrorCategory } from './errors';

export interface BackoffPolicy {
  readonly baseMs: number;
  readonly maxMs: number;
  readonly factor: number;
  /** Upper bound applied to a server supplied Retry-After, as a safety net. */
  readonly maxRetryAfterMs: number;
  readonly maxAttempts: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = {
  baseMs: 1_000,
  maxMs: 60_000,
  factor: 2,
  maxRetryAfterMs: 15 * 60_000,
  maxAttempts: 5,
};

export interface RetryDecisionInput {
  readonly category: ErrorCategory;
  /** Attempts already made for this step, including the one that just failed. */
  readonly attempt: number;
  readonly retryAfterMs?: number | undefined;
  readonly policy?: BackoffPolicy;
  readonly random?: () => number;
}

export type RetryDecision =
  | { readonly action: 'RETRY'; readonly delayMs: number; readonly honouredRetryAfter: boolean }
  | { readonly action: 'NEEDS_REVIEW' }
  | { readonly action: 'FAIL' };

/**
 * A server supplied Retry-After always wins over the local backoff curve, as
 * required by docs/requirements.md section 5. Otherwise the delay grows
 * exponentially with jitter so that parallel workers do not resynchronise.
 */
export function nextDelayMs(input: RetryDecisionInput): number {
  const policy = input.policy ?? DEFAULT_BACKOFF;
  if (input.retryAfterMs !== undefined && input.retryAfterMs >= 0) {
    return Math.min(input.retryAfterMs, policy.maxRetryAfterMs);
  }
  const random = input.random ?? Math.random;
  const exponent = Math.max(0, input.attempt - 1);
  const ceiling = Math.min(policy.maxMs, policy.baseMs * policy.factor ** exponent);
  const jittered = ceiling / 2 + random() * (ceiling / 2);
  return Math.round(jittered);
}

export function decideRetry(input: RetryDecisionInput): RetryDecision {
  const policy = input.policy ?? DEFAULT_BACKOFF;
  const meta = ERROR_CATEGORY_META[input.category];
  const exhausted = input.attempt >= policy.maxAttempts;

  if (meta.retryable && !exhausted) {
    const delayMs = nextDelayMs({ ...input, policy });
    return {
      action: 'RETRY',
      delayMs,
      honouredRetryAfter: input.retryAfterMs !== undefined && input.retryAfterMs >= 0,
    };
  }
  if (meta.needsReview) return { action: 'NEEDS_REVIEW' };
  return { action: 'FAIL' };
}

/** Parse a Retry-After header in either delta-seconds or HTTP-date form. */
export function parseRetryAfter(
  header: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000;
  const asDate = Date.parse(trimmed);
  if (Number.isNaN(asDate)) return undefined;
  return Math.max(0, asDate - now);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    if (signal?.aborted) {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
