import { beforeEach, describe, expect, it } from 'vitest';
import { migrationItemId } from '@shuttle-lite/core';
import {
  LATEST_SCHEMA_VERSION,
  migrate,
  openDatabase,
  schemaVersion,
  ShuttleStore,
} from '@shuttle-lite/db';

function createStore(): ShuttleStore {
  const db = openDatabase({ path: ':memory:' });
  migrate(db);
  return new ShuttleStore(db, {
    telemetryPayload: (event) => ({ eventId: event.id, phase: event.phase, status: event.status }),
  });
}

function seed(store: ShuttleStore) {
  const profile = store.createProfile({
    name: `profile-${Math.random()}`,
    sourceRootPath: '/tmp/source',
    targetStagingFolderId: '0',
    destinationCatalogId: 'default',
    proxyProfileName: 'none',
    metadataTemplateKey: 'shuttleLiteMigration',
    fileConcurrency: 3,
    chunkConcurrency: 3,
    aiRoutingEnabled: true,
    snowflakeLoggingEnabled: true,
    conflictPolicy: 'RENAME',
  });
  const job = store.createJob({ profileId: profile.id, operatorLabel: 'tester' });
  const itemId = migrationItemId(job.id, 'legal/msa.pdf');
  store.upsertScannedItem({
    id: itemId,
    jobId: job.id,
    sourceRelativePath: 'legal/msa.pdf',
    sourceAbsolutePath: '/tmp/source/legal/msa.pdf',
    sourceFileName: 'msa.pdf',
    sourceSize: 1024,
    sourceModifiedAt: '2026-09-01T00:00:00.000Z',
    sourceInode: '1',
    fileType: 'pdf',
  });
  return { profile, job, itemId };
}

describe('sqlite store', () => {
  let store: ShuttleStore;

  beforeEach(() => {
    store = createStore();
  });

  it('applies the schema once and records the version', () => {
    expect(schemaVersion(store.db)).toBe(LATEST_SCHEMA_VERSION);
    const tables = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toEqual([
      'extraction_results',
      'job_commands',
      'migration_events',
      'migration_items',
      'migration_jobs',
      'migration_profiles',
      'routing_decisions',
      'snowflake_outbox',
      'upload_parts',
      'upload_sessions',
    ]);
  });

  it('leases a job to one worker at a time', () => {
    seed(store);
    const first = store.claimJob('worker-a', 60_000);
    expect(first).not.toBeNull();
    expect(store.claimJob('worker-b', 60_000)).toBeNull();
    expect(store.renewLease(first!.id, 'worker-a', 60_000)).toBe(true);
    expect(store.renewLease(first!.id, 'worker-b', 60_000)).toBe(false);
    store.releaseLease(first!.id, 'worker-a');
    expect(store.claimJob('worker-b', 60_000)?.id).toBe(first!.id);
  });

  it('reclaims a job whose lease expired with the worker that held it', () => {
    seed(store);
    const claimed = store.claimJob('crashed-worker', -1_000);
    expect(claimed).not.toBeNull();
    expect(store.claimJob('fresh-worker', 60_000)?.id).toBe(claimed!.id);
  });

  it('writes the state change, the event and the outbox row in one transaction', () => {
    const { job, itemId } = seed(store);
    store.transitionItem({
      itemId,
      to: 'HASHING',
      expectedFrom: 'DISCOVERED',
      event: { status: 'STARTED' },
    });
    const events = store.listEvents(job.id);
    expect(events).toHaveLength(1);
    expect(store.getOutbox(events[0]!.id)?.state).toBe('PENDING');
    expect(store.getItem(itemId)?.state).toBe('HASHING');
  });

  it('rejects a transition that would skip verification, leaving no event behind', () => {
    const { job, itemId } = seed(store);
    expect(() =>
      store.transitionItem({ itemId, to: 'COMPLETED', event: { status: 'SUCCEEDED' } }),
    ).toThrowError(/許可されない遷移/);
    expect(store.getItem(itemId)?.state).toBe('DISCOVERED');
    expect(store.listEvents(job.id)).toHaveLength(0);
  });

  it('refuses a transition when another writer already moved the item', () => {
    const { itemId } = seed(store);
    store.transitionItem({ itemId, to: 'HASHING' });
    expect(() =>
      store.transitionItem({ itemId, to: 'PREFLIGHT', expectedFrom: 'DISCOVERED' }),
    ).toThrowError(/状態が/);
  });

  it('leaves an unchanged item alone on rescan', () => {
    const { job, itemId } = seed(store);
    store.transitionItem({ itemId, to: 'HASHING' });
    const result = store.upsertScannedItem({
      id: itemId,
      jobId: job.id,
      sourceRelativePath: 'legal/msa.pdf',
      sourceAbsolutePath: '/tmp/source/legal/msa.pdf',
      sourceFileName: 'msa.pdf',
      sourceSize: 1024,
      sourceModifiedAt: '2026-09-01T00:00:00.000Z',
      sourceInode: '1',
      fileType: 'pdf',
    });
    expect(result).toBe('UNCHANGED');
    expect(store.getItem(itemId)?.state).toBe('HASHING');
  });

  it('restarts an in-flight item whose source changed', () => {
    const { job, itemId } = seed(store);
    store.transitionItem({ itemId, to: 'HASHING', patch: { sourceSha1: 'abc' } });
    const result = store.upsertScannedItem({
      id: itemId,
      jobId: job.id,
      sourceRelativePath: 'legal/msa.pdf',
      sourceAbsolutePath: '/tmp/source/legal/msa.pdf',
      sourceFileName: 'msa.pdf',
      sourceSize: 2048,
      sourceModifiedAt: '2026-09-02T00:00:00.000Z',
      sourceInode: '1',
      fileType: 'pdf',
    });
    expect(result).toBe('RESCANNED');
    const item = store.getItem(itemId);
    expect(item?.state).toBe('DISCOVERED');
    expect(item?.sourceSha1).toBeNull();
    expect(item?.sourceSize).toBe(2048);
  });

  it('never resets a completed item when the source changes later', () => {
    const { job, itemId } = seed(store);
    for (const to of [
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
    ] as const) {
      store.transitionItem({ itemId, to });
    }
    const result = store.upsertScannedItem({
      id: itemId,
      jobId: job.id,
      sourceRelativePath: 'legal/msa.pdf',
      sourceAbsolutePath: '/tmp/source/legal/msa.pdf',
      sourceFileName: 'msa.pdf',
      sourceSize: 4096,
      sourceModifiedAt: '2026-09-03T00:00:00.000Z',
      sourceInode: '1',
      fileType: 'pdf',
    });
    expect(result).toBe('UNCHANGED');
    const item = store.getItem(itemId);
    expect(item?.state).toBe('COMPLETED');
    expect(item?.lastErrorCategory).toBe('SOURCE_CHANGED');
  });

  it('claims outbox rows once and can redeliver a failed batch', () => {
    const { job, itemId } = seed(store);
    store.transitionItem({ itemId, to: 'HASHING', event: { status: 'STARTED' } });
    const first = store.claimOutboxBatch(10);
    expect(first).toHaveLength(1);
    expect(store.claimOutboxBatch(10)).toHaveLength(0);

    store.markOutboxFailed(
      first.map((r) => r.eventId),
      'snowflake unavailable',
      new Date(Date.now() - 1_000).toISOString(),
    );
    const retry = store.claimOutboxBatch(10);
    expect(retry).toHaveLength(1);
    expect(retry[0]!.attempts).toBe(2);

    store.markOutboxDelivered(retry.map((r) => r.eventId));
    expect(store.claimOutboxBatch(10)).toHaveLength(0);
    expect(store.outboxStatus(job.id)).toEqual({ pending: 0, failed: 0, delivered: 1 });
  });

  it('claims a command exactly once', () => {
    const { job } = seed(store);
    store.enqueueCommand(job.id, 'START_JOB');
    expect(store.claimCommands()).toHaveLength(1);
    expect(store.claimCommands()).toHaveLength(0);
  });

  it('skips items that are waiting out a retry backoff', () => {
    const { job, itemId } = seed(store);
    const future = new Date(Date.now() + 60_000).toISOString();
    store.updateItem(itemId, { nextAttemptAt: future });
    expect(store.listReadyItems(job.id, ['DISCOVERED'], 10)).toHaveLength(0);
    store.updateItem(itemId, { nextAttemptAt: null });
    expect(store.listReadyItems(job.id, ['DISCOVERED'], 10)).toHaveLength(1);
  });
});
