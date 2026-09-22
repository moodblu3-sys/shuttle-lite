import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrationItemId, ShuttleError } from '@shuttle-lite/core';
import { migrate, openDatabase, ShuttleStore } from '@shuttle-lite/db';
import {
  assertPayloadAllowlisted,
  buildTelemetryPayload,
  FORBIDDEN_TELEMETRY_KEYS,
  JsonlTelemetrySink,
  OutboxSender,
  TELEMETRY_FIELDS,
  type TelemetryRecord,
  type TelemetrySink,
} from '@shuttle-lite/telemetry';

function createStore(): ShuttleStore {
  const db = openDatabase({ path: ':memory:' });
  migrate(db);
  return new ShuttleStore(db, { telemetryPayload: buildTelemetryPayload });
}

function seed(store: ShuttleStore) {
  const profile = store.createProfile({
    name: `p-${Math.random()}`,
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
    sourceAbsolutePath: '/Users/secret/source/legal/msa.pdf',
    sourceFileName: 'msa.pdf',
    sourceSize: 1024,
    sourceModifiedAt: '2026-09-01T00:00:00.000Z',
    sourceInode: '1',
    fileType: 'pdf',
  });
  return { job, itemId };
}

describe('telemetry payload allowlist', () => {
  it('sends only allowlisted fields', () => {
    const store = createStore();
    const { job, itemId } = seed(store);
    store.transitionItem({
      itemId,
      to: 'HASHING',
      event: {
        status: 'STARTED',
        message: '/Users/secret/source/legal/msa.pdf を読み込み中',
        sizeBytes: 1024,
        boxFileId: 'fil1001',
      },
    });
    const [event] = store.listEvents(job.id);
    const payload = store.getOutbox(event!.id)?.payload ?? {};
    expect(Object.keys(payload).sort()).toEqual([...TELEMETRY_FIELDS].sort());
    expect(() => assertPayloadAllowlisted(payload)).not.toThrow();
  });

  it('never carries the event message or a local path', () => {
    const store = createStore();
    const { job, itemId } = seed(store);
    store.transitionItem({
      itemId,
      to: 'HASHING',
      event: { status: 'STARTED', message: '/Users/secret/source/legal/msa.pdf' },
    });
    const [event] = store.listEvents(job.id);
    const serialized = JSON.stringify(store.getOutbox(event!.id)?.payload);
    expect(serialized).not.toContain('/Users/secret');
    expect(serialized).not.toContain('msa.pdf');
    for (const key of FORBIDDEN_TELEMETRY_KEYS) {
      expect(serialized).not.toContain(`"${key}"`);
    }
  });

  it('rejects a payload that gained a field', () => {
    expect(() => assertPayloadAllowlisted({ jobId: 'job_1', accessToken: 'secret' })).toThrowError(
      /許可されていないfield/,
    );
  });
});

describe('outbox sender', () => {
  let dir: string;
  let store: ShuttleStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shuttle-telemetry-'));
    store = createStore();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes each event once, even if a batch is redelivered', async () => {
    const { job, itemId } = seed(store);
    store.transitionItem({ itemId, to: 'HASHING', event: { status: 'STARTED' } });
    store.transitionItem({ itemId, to: 'PREFLIGHT', event: { status: 'SUCCEEDED' } });

    const sink = new JsonlTelemetrySink(join(dir, 'events.jsonl'));
    const sender = new OutboxSender({ store, sink, batchSize: 10 });
    expect(await sender.runOnce()).toEqual({ claimed: 2, delivered: 2, failed: 0 });

    // Simulate an unknown delivery outcome: the same rows are claimed again.
    store.markOutboxFailed(
      store.listEvents(job.id).map((event) => event.id),
      'unknown outcome',
      new Date(Date.now() - 1_000).toISOString(),
    );
    expect(await sender.runOnce()).toEqual({ claimed: 2, delivered: 2, failed: 0 });

    const lines = readFileSync(sink.path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const ids = lines.map((line) => (JSON.parse(line) as { eventId: string }).eventId);
    expect(new Set(ids).size).toBe(2);
  });

  it('recovers a crashed sender after its lease expires without stealing a live batch', async () => {
    const { job, itemId } = seed(store);
    store.transitionItem({ itemId, to: 'HASHING', event: { status: 'STARTED' } });
    const initial = store.claimOutboxBatch(10);
    expect(initial).toHaveLength(1);
    expect(store.claimOutboxBatch(10)).toHaveLength(0);
    store.renewOutboxLease(initial.map((row) => row.eventId));
    expect(store.claimOutboxBatch(10, new Date(Date.now() + 60_000).toISOString())).toHaveLength(0);
    const retried = store.claimOutboxBatch(10, new Date(Date.now() + 121_000).toISOString());
    expect(retried.map((row) => row.eventId)).toEqual(initial.map((row) => row.eventId));
    expect(retried[0]?.attempts).toBe(2);
    expect(store.outboxStatus(job.id).pending).toBe(1);
  });

  it('keeps the backlog and does not lose events when the sink is down', async () => {
    const { job, itemId } = seed(store);
    store.transitionItem({ itemId, to: 'HASHING', event: { status: 'STARTED' } });

    const failing: TelemetrySink = {
      name: 'failing',
      deliver: async () => {
        throw new ShuttleError('TELEMETRY_DELIVERY', 'snowflake unavailable');
      },
    };
    const sender = new OutboxSender({ store, sink: failing, batchSize: 10 });
    expect(await sender.runOnce()).toEqual({ claimed: 1, delivered: 0, failed: 1 });
    expect(store.outboxStatus(job.id)).toEqual({ pending: 0, failed: 1, delivered: 0 });

    // The row is not deliverable until its backoff elapses.
    expect(await sender.runOnce()).toEqual({ claimed: 0, delivered: 0, failed: 0 });

    const recovered: TelemetryRecord[] = [];
    const working: TelemetrySink = {
      name: 'working',
      deliver: async (records) => {
        recovered.push(...records);
      },
    };
    store.markOutboxFailed(
      store.listEvents(job.id).map((event) => event.id),
      'retry now',
      new Date(Date.now() - 1_000).toISOString(),
    );
    const second = new OutboxSender({ store, sink: working, batchSize: 10 });
    expect(await second.runOnce()).toEqual({ claimed: 1, delivered: 1, failed: 0 });
    expect(recovered).toHaveLength(1);
    expect(store.outboxStatus(job.id).delivered).toBe(1);
  });
});
