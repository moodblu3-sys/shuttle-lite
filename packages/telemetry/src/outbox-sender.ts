import {
  DEFAULT_BACKOFF,
  type BackoffPolicy,
  type Logger,
  nextDelayMs,
  sleep,
  toShuttleError,
} from '@shuttle-lite/core';
import type { ShuttleStore } from '@shuttle-lite/db';
import { assertPayloadAllowlisted } from './payload';
import type { TelemetrySink } from './sink';

export interface OutboxSenderOptions {
  readonly store: ShuttleStore;
  readonly sink: TelemetrySink;
  readonly batchSize: number;
  readonly pollIntervalMs?: number;
  readonly policy?: BackoffPolicy;
  readonly logger?: Logger;
}

export interface SendResult {
  readonly claimed: number;
  readonly delivered: number;
  readonly failed: number;
}

/**
 * Drains the transactional outbox. A failure here is never a migration
 * failure: rows go back to FAILED with a backoff and are retried with the
 * same event IDs, so Snowflake can deduplicate (acceptance criteria 12, 13).
 */
export class OutboxSender {
  readonly #options: OutboxSenderOptions;
  #running = false;
  #stopped = false;

  constructor(options: OutboxSenderOptions) {
    this.#options = options;
  }

  async runOnce(): Promise<SendResult> {
    const { store, sink, batchSize, logger } = this.#options;
    const batch = store.claimOutboxBatch(batchSize);
    if (batch.length === 0) return { claimed: 0, delivered: 0, failed: 0 };

    const records = batch.map((row) => {
      assertPayloadAllowlisted(row.payload);
      return { eventId: row.eventId, jobId: row.jobId, payload: row.payload };
    });

    try {
      await sink.deliver(records);
      store.markOutboxDelivered(batch.map((row) => row.eventId));
      logger?.debug('telemetry delivered', { sink: sink.name, count: batch.length });
      return { claimed: batch.length, delivered: batch.length, failed: 0 };
    } catch (error) {
      const shuttleError = toShuttleError(error, 'TELEMETRY_DELIVERY');
      const attempt = Math.max(...batch.map((row) => row.attempts), 1);
      const delayMs = nextDelayMs({
        category: 'TELEMETRY_DELIVERY',
        attempt,
        retryAfterMs: shuttleError.retryAfterMs,
        policy: this.#options.policy ?? DEFAULT_BACKOFF,
      });
      store.markOutboxFailed(
        batch.map((row) => row.eventId),
        shuttleError.message,
        new Date(Date.now() + delayMs).toISOString(),
      );
      logger?.warn('telemetry delivery failed, migration continues', {
        sink: sink.name,
        count: batch.length,
        retryInMs: delayMs,
        category: shuttleError.category,
      });
      return { claimed: batch.length, delivered: 0, failed: batch.length };
    }
  }

  async start(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    this.#stopped = false;
    const interval = this.#options.pollIntervalMs ?? 2_000;
    while (!this.#stopped) {
      const result = await this.runOnce();
      if (result.claimed === 0) await sleep(interval);
    }
    this.#running = false;
  }

  stop(): void {
    this.#stopped = true;
  }

  async close(): Promise<void> {
    this.stop();
    await this.#options.sink.close?.();
  }
}
