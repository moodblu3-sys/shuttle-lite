import { describe, expect, it } from 'vitest';
import { decideRetry, DEFAULT_BACKOFF, nextDelayMs, parseRetryAfter } from '@shuttle-lite/core';

describe('retry policy', () => {
  it('honours Retry-After instead of the local backoff curve', () => {
    const delay = nextDelayMs({ category: 'BOX_RATE_LIMIT', attempt: 1, retryAfterMs: 37_000 });
    expect(delay).toBe(37_000);

    const decision = decideRetry({
      category: 'BOX_RATE_LIMIT',
      attempt: 1,
      retryAfterMs: 37_000,
    });
    expect(decision).toEqual({ action: 'RETRY', delayMs: 37_000, honouredRetryAfter: true });
  });

  it('honours Retry-After: 0 without falling back to exponential delay', () => {
    expect(nextDelayMs({ category: 'BOX_RATE_LIMIT', attempt: 4, retryAfterMs: 0 })).toBe(0);
  });

  it('caps an absurd Retry-After at the policy ceiling', () => {
    const delay = nextDelayMs({
      category: 'BOX_RATE_LIMIT',
      attempt: 1,
      retryAfterMs: 24 * 60 * 60_000,
    });
    expect(delay).toBe(DEFAULT_BACKOFF.maxRetryAfterMs);
  });

  it('grows exponentially with jitter inside the documented bounds', () => {
    for (const attempt of [1, 2, 3, 4, 10]) {
      const ceiling = Math.min(
        DEFAULT_BACKOFF.maxMs,
        DEFAULT_BACKOFF.baseMs * DEFAULT_BACKOFF.factor ** (attempt - 1),
      );
      const low = nextDelayMs({ category: 'BOX_SERVER', attempt, random: () => 0 });
      const high = nextDelayMs({ category: 'BOX_SERVER', attempt, random: () => 0.999 });
      expect(low).toBe(Math.round(ceiling / 2));
      expect(high).toBeLessThanOrEqual(ceiling);
      expect(high).toBeGreaterThan(low);
    }
  });

  it('does not retry a permanent 4xx', () => {
    expect(decideRetry({ category: 'BOX_BAD_REQUEST', attempt: 1 })).toEqual({ action: 'FAIL' });
    expect(decideRetry({ category: 'BOX_AUTH', attempt: 1 })).toEqual({ action: 'FAIL' });
  });

  it('sends a conflicting name to review rather than overwriting', () => {
    expect(decideRetry({ category: 'BOX_CONFLICT', attempt: 1 })).toEqual({
      action: 'NEEDS_REVIEW',
    });
  });

  it('stops retrying once the attempt budget is spent', () => {
    const attempt = DEFAULT_BACKOFF.maxAttempts;
    expect(decideRetry({ category: 'BOX_SERVER', attempt })).toEqual({ action: 'FAIL' });
    expect(decideRetry({ category: 'AI_FAILURE', attempt })).toEqual({ action: 'NEEDS_REVIEW' });
  });

  it('parses both Retry-After forms', () => {
    expect(parseRetryAfter('12')).toBe(12_000);
    const now = Date.UTC(2026, 8, 13, 0, 0, 0);
    expect(parseRetryAfter('Sun, 13 Sep 2026 00:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('not-a-date')).toBeUndefined();
  });
});
