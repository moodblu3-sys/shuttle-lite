import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { isDatabaseBusy, openDatabase } from '@shuttle-lite/db';
import { createHarness, runUntilIdle, approveItem, type Harness } from './harness';
import { getConfig, getStore } from '../apps/web/src/lib/runtime';
import { processCommands } from '../apps/worker/src/commands';
import { POST } from '../apps/web/src/app/api/jobs/[jobId]/commands/route';

vi.mock('../apps/web/src/lib/runtime', () => ({ getConfig: vi.fn(), getStore: vi.fn() }));
let h: Harness;
beforeEach(async () => {
  h = await createHarness();
  vi.mocked(getConfig).mockReturnValue(h.config);
  vi.mocked(getStore).mockReturnValue(h.store);
});
afterEach(() => {
  vi.restoreAllMocks();
  h.cleanup();
});

it('waits for another SQLite writer before reading inside a transaction', async () => {
  h.store.db.exec(
    'CREATE TABLE contention_probe (value INTEGER); INSERT INTO contention_probe VALUES (0)',
  );
  const worker = new Worker(
    `
    const {parentPort,workerData} = require('node:worker_threads');
    const Database = require(workerData.module);
    const db = new Database(workerData.path);
    db.exec('BEGIN IMMEDIATE; UPDATE contention_probe SET value = 1');
    parentPort.postMessage('locked');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,150);
    db.exec('COMMIT'); db.close();
  `,
    {
      eval: true,
      workerData: {
        module: createRequire(import.meta.url).resolve('better-sqlite3'),
        path: h.config.sqlitePath,
      },
    },
  );
  try {
    await new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    const result = h.store.transaction(() => {
      const row = h.store.db.prepare('SELECT value FROM contention_probe').get() as {
        value: number;
      };
      h.store.db.prepare('UPDATE contention_probe SET value = ?').run(row.value + 1);
      return row.value;
    });
    expect(result).toBe(1);
  } finally {
    await worker.terminate();
  }
});

it('returns a retryable JSON receipt for a real database lock without saving a command', async () => {
  const job = h.store.createJob({ profileId: h.createProfile().id, operatorLabel: 'test' });
  const other = openDatabase({ path: h.config.sqlitePath });
  h.store.db.pragma('busy_timeout = 10');
  other.exec('BEGIN IMMEDIATE');
  const call = () =>
    POST(
      new Request('http://localhost/commands', {
        method: 'POST',
        body: JSON.stringify({ type: 'START_JOB' }),
      }),
      { params: Promise.resolve({ jobId: job.id }) },
    );
  try {
    const response = await call();
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('1');
    expect(await response.json()).toMatchObject({ code: 'DATABASE_BUSY' });
    expect(h.store.listCommands(job.id)).toHaveLength(0);
  } finally {
    other.exec('ROLLBACK');
    other.close();
  }
  expect((await call()).status).toBe(202);
  expect(h.store.listCommands(job.id)).toHaveLength(1);
});

it('does not classify other database errors as contention', () => {
  expect(isDatabaseBusy({ code: 'SQLITE_BUSY_SNAPSHOT' })).toBe(true);
  expect(isDatabaseBusy({ code: 'SQLITE_CONSTRAINT' })).toBe(false);
});

it('accepts and processes 100 approvals while another connection writes', async () => {
  const job = h.store.createJob({ profileId: h.createProfile().id, operatorLabel: 'test' });
  for (let i = 0; i < 100; i++) h.writeSource(`contract-${i}.txt`, 'NDA contract');
  h.store.enqueueCommand(job.id, 'START_JOB');
  await runUntilIdle(h, 1000);
  const items = h.store.listItems(job.id);
  expect(items).toHaveLength(100);
  expect(items.every((item) => item.state === 'REVIEW_REQUIRED')).toBe(true);
  h.store.db.exec(
    'CREATE TABLE contention_probe (value INTEGER); INSERT INTO contention_probe VALUES (0)',
  );
  const worker = new Worker(
    `
    const {parentPort,workerData} = require('node:worker_threads');
    const Database = require(workerData.module);
    const db = new Database(workerData.path);
    parentPort.postMessage('ready');
    const wait = new Int32Array(new SharedArrayBuffer(4));
    for(let i=0; i<100; i++) {
      db.exec('BEGIN IMMEDIATE; UPDATE contention_probe SET value = value + 1');
      Atomics.wait(wait,0,0,2); db.exec('COMMIT'); Atomics.wait(wait,0,0,2);
    }
    db.close();
  `,
    {
      eval: true,
      workerData: {
        module: createRequire(import.meta.url).resolve('better-sqlite3'),
        path: h.config.sqlitePath,
      },
    },
  );
  try {
    await new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    for (const item of items) {
      h.store.transaction(() => approveItem(h, item, h.catalog.entries[0]!.key));
      await processCommands(h.ctx);
    }
    expect(h.store.listItems(job.id).every((item) => item.state === 'APPROVED')).toBe(true);
    const approvals = h.store.listCommands(job.id, 200).filter((c) => c.type === 'APPROVE_ITEM');
    expect(approvals).toHaveLength(100);
    expect(approvals.every((c) => c.state === 'DONE')).toBe(true);
  } finally {
    await worker.terminate();
  }
});
