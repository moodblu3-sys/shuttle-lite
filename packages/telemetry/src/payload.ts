import type { MigrationEventRecord } from '@shuttle-lite/core';

/**
 * The only fields allowed to leave the machine (docs/requirements.md 4.14).
 * This is an allowlist, not a redaction pass: anything not listed here can
 * never reach Snowflake, including the human readable event message, which may
 * contain file names or local paths.
 */
export const TELEMETRY_FIELDS = [
  'eventId',
  'jobId',
  'itemId',
  'phase',
  'status',
  'sizeBytes',
  'durationMs',
  'retryCount',
  'errorCategory',
  'boxFileId',
  'destinationKey',
  'aiUsed',
  'humanOverride',
  'occurredAt',
] as const;

export type TelemetryField = (typeof TELEMETRY_FIELDS)[number];
export type TelemetryPayload = Record<TelemetryField, unknown>;

export const FORBIDDEN_TELEMETRY_KEYS = [
  'message',
  'sourceRelativePath',
  'sourceAbsolutePath',
  'sourceFileName',
  'content',
  'accessToken',
  'clientSecret',
  'proxyPassword',
  'aiResponse',
  'reason',
] as const;

export function buildTelemetryPayload(event: MigrationEventRecord): TelemetryPayload {
  return {
    eventId: event.id,
    jobId: event.jobId,
    itemId: event.itemId,
    phase: event.phase,
    status: event.status,
    sizeBytes: event.sizeBytes,
    durationMs: event.durationMs,
    retryCount: event.retryCount,
    errorCategory: event.errorCategory,
    boxFileId: event.boxFileId,
    destinationKey: event.destinationKey,
    aiUsed: event.aiUsed,
    humanOverride: event.humanOverride,
    occurredAt: event.createdAt,
  };
}

/** Used by tests and by the sender as a last line of defence before delivery. */
export function assertPayloadAllowlisted(payload: Record<string, unknown>): void {
  const allowed = new Set<string>(TELEMETRY_FIELDS);
  const extra = Object.keys(payload).filter((key) => !allowed.has(key));
  if (extra.length > 0) {
    throw new Error(
      `telemetry payloadに許可されていないfieldが含まれています: ${extra.join(', ')}`,
    );
  }
}
