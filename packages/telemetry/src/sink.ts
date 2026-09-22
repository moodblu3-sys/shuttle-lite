import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AppConfig } from '@shuttle-lite/config';
import { SnowflakeTelemetrySink } from './snowflake';
export { SnowflakeTelemetrySink } from './snowflake';

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
    if (existsSync(path)) {
      for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
        const record: unknown = JSON.parse(line);
        if (
          record &&
          typeof record === 'object' &&
          'eventId' in record &&
          typeof record.eventId === 'string'
        )
          this.#seen.add(record.eventId);
      }
    }
  }

  get path(): string {
    return this.#path;
  }

  async deliver(records: readonly TelemetryRecord[]): Promise<void> {
    const pending = records.filter((record) => !this.#seen.has(record.eventId));
    const lines = pending.map((record) =>
      JSON.stringify({
        ...record.payload,
        eventId: record.eventId,
        _deliveredAt: new Date().toISOString(),
      }),
    );
    if (lines.length === 0) return;
    appendFileSync(this.#path, `${lines.join('\n')}\n`);
    for (const record of pending) this.#seen.add(record.eventId);
  }
}

export function createTelemetrySink(config: AppConfig): TelemetrySink {
  return config.telemetry.sink === 'snowflake'
    ? new SnowflakeTelemetrySink(config)
    : new JsonlTelemetrySink(config.telemetry.jsonlPath);
}
