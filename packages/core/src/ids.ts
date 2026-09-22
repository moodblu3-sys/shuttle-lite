import { createHash, randomBytes, randomUUID } from 'node:crypto';

export function randomId(prefix: string, bytes = 8): string {
  return `${prefix}_${randomBytes(bytes).toString('hex')}`;
}

export function newJobId(): string {
  return randomId('job');
}

export function newProfileId(): string {
  return randomId('prf');
}

export function newCommandId(): string {
  return randomId('cmd');
}

/**
 * Event IDs are used as the Snowflake deduplication key, so they must be
 * globally unique and stable once written to the outbox.
 */
export function newEventId(): string {
  return `evt_${randomUUID()}`;
}

/**
 * Stable within a job: rescanning the same source root produces the same item
 * ID for the same relative path, which is what makes reconciliation by
 * deterministic staging name possible after a crash.
 */
export function migrationItemId(jobId: string, sourceRelativePath: string): string {
  const digest = createHash('sha256').update(`${jobId}\n${sourceRelativePath}`).digest('hex');
  return `it_${digest.slice(0, 24)}`;
}
