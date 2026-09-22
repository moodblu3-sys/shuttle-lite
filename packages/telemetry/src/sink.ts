import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AppConfig } from '@shuttle-lite/config';
import { ShuttleError } from '@shuttle-lite/core';

export interface TelemetryRecord {
  readonly eventId: string;
  readonly jobId: string;
  readonly payload: Record<string, unknown>;
}

export interface TelemetrySink {
  readonly name: string;
  /**
   * Must be idempotent on `eventId`: a delivery whose outcome is unknown is
   * retried with the same IDs (docs/architecture.md section 11).
   */
  deliver(records: readonly TelemetryRecord[]): Promise<void>;
  close?(): Promise<void>;
}

/** Local stand-in for Snowflake. Append-only, one JSON object per line. */
export class JsonlTelemetrySink implements TelemetrySink {
  readonly name = 'jsonl';
  readonly #path: string;
  readonly #seen = new Set<string>();

  constructor(path: string) {
    this.#path = path;
    mkdirSync(dirname(path), { recursive: true });
  }

  get path(): string {
    return this.#path;
  }

  async deliver(records: readonly TelemetryRecord[]): Promise<void> {
    const lines = records
      .filter((record) => !this.#seen.has(record.eventId))
      .map((record) => {
        this.#seen.add(record.eventId);
        return JSON.stringify({ ...record.payload, _deliveredAt: new Date().toISOString() });
      });
    if (lines.length === 0) return;
    appendFileSync(this.#path, `${lines.join('\n')}\n`);
  }
}

/**
 * Placeholder until the Snowflake account exists. It fails with a retryable
 * category on purpose: a Snowflake outage must never stop a migration, so the
 * rows stay in the outbox and show up as delivery backlog in the UI.
 *
 * The target table is expected to deduplicate on EVENT_ID, for example:
 *
 *   MERGE INTO shuttle_lite_events t
 *   USING (SELECT ? AS event_id, ...) s ON t.event_id = s.event_id
 *   WHEN NOT MATCHED THEN INSERT (...) VALUES (...);
 */
export class SnowflakeTelemetrySink implements TelemetrySink {
  readonly name = 'snowflake';

  constructor(private readonly config: AppConfig) {}

  async deliver(records: readonly TelemetryRecord[]): Promise<void> {
    throw new ShuttleError(
      'TELEMETRY_DELIVERY',
      `Snowflake sinkは未接続です。${records.length}件をoutboxに保持します。docs/integration-todo.md の Snowflake手順を実施してください。`,
      { details: { account: this.config.telemetry.snowflake.account ?? '(unset)' } },
    );
  }
}

export function createTelemetrySink(config: AppConfig): TelemetrySink {
  return config.telemetry.sink === 'snowflake'
    ? new SnowflakeTelemetrySink(config)
    : new JsonlTelemetrySink(config.telemetry.jsonlPath);
}
