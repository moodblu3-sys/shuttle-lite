import type { AppConfig } from '@shuttle-lite/config';
import { createTelemetrySink, type TelemetrySink, type TelemetryRecord } from './sink';

/** Snapshot a destination for the whole batch; apply saved changes on the next batch. */
export class ConfiguredTelemetrySink implements TelemetrySink {
  readonly name = 'configured';
  #key = '';
  #sink?: TelemetrySink;
  constructor(private readonly readConfig: () => AppConfig) {}
  async deliver(records: readonly TelemetryRecord[]): Promise<void> {
    const config = this.readConfig();
    const key = JSON.stringify(config.telemetry);
    if (key !== this.#key || !this.#sink) {
      await this.#sink?.close?.();
      this.#sink = undefined;
      this.#sink = createTelemetrySink(config);
      this.#key = key;
    }
    await this.#sink.deliver(records);
  }
  async close(): Promise<void> {
    await this.#sink?.close?.();
  }
}
