import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyRuntimeSettings, parseEnv, settingsFromConfig } from '@shuttle-lite/config';
import { openDatabase, ShuttleStore } from '@shuttle-lite/db';
import { ConfiguredTelemetrySink, OutboxSender } from '@shuttle-lite/telemetry';
import { GET, PUT } from '../apps/web/src/app/api/settings/route';
import { getConfig, getStore } from '../apps/web/src/lib/runtime';
import { processCommands } from '../apps/worker/src/commands';
import { createHarness, runUntilIdle, type Harness } from './harness';

vi.mock('../apps/web/src/lib/runtime', () => ({ getConfig: vi.fn(), getStore: vi.fn() }));

function request(settings: unknown, revision = 0, origin = 'http://localhost') {
  return new Request('http://localhost/api/settings', {
    method: 'PUT',
    headers: {
      origin,
      'Content-Type': 'application/json',
      'x-shuttle-settings': '1',
    },
    body: JSON.stringify({ settings, revision }),
  });
}

describe('saved settings drive migration and logging', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await createHarness();
    vi.mocked(getStore).mockReturnValue(harness.store);
    vi.mocked(getConfig).mockImplementation(() =>
      applyRuntimeSettings(harness.config, harness.store.getRuntimeSettings().settings),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    harness.cleanup();
  });

  it('persists across database connections and rejects stale saves', async () => {
    const settings = {
      ...settingsFromConfig(harness.config),
      aiEnabled: false,
      fileConcurrency: 5,
      chunkConcurrency: 4,
      logFolder: harness.dataDir,
    };
    expect((await PUT(request(settings))).status).toBe(200);
    const connection = openDatabase({ path: harness.config.sqlitePath });
    try {
      expect(new ShuttleStore(connection).getRuntimeSettings()).toEqual({ revision: 1, settings });
    } finally {
      connection.close();
    }
    expect(await (await GET()).json()).toEqual({ revision: 1, settings });
    expect((await PUT(request({ ...settings, aiEnabled: true }))).status).toBe(409);
    expect(harness.store.getRuntimeSettings().settings).toEqual(settings);
  });

  it.each([
    { fileConcurrency: 6 },
    { chunkConcurrency: 5 },
    { fileConcurrency: 0 },
    { chunkConcurrency: 1.5 },
    { aiEnabled: 'true' },
    { fileConcurrency: '2' },
    { logFolder: 'relative' },
    { box: { accessToken: 'not-allowed' } },
  ])('rejects invalid API settings without changing saved values: %j', async (override) => {
    expect(
      (await PUT(request({ ...settingsFromConfig(harness.config), ...override }))).status,
    ).toBe(400);
    expect(harness.store.getRuntimeSettings().revision).toBe(0);
  });

  it('enforces the same concurrency caps on env values', () => {
    expect(() => parseEnv({ FILE_CONCURRENCY: '6' } as NodeJS.ProcessEnv)).toThrow();
    expect(() => parseEnv({ CHUNK_CONCURRENCY: '5' } as NodeJS.ProcessEnv)).toThrow();
  });

  it('blocks cross-origin writes and malformed JSON', async () => {
    expect(
      (await PUT(request(settingsFromConfig(harness.config), 0, 'https://example.org'))).status,
    ).toBe(403);
    expect(
      (
        await PUT(
          new Request('http://localhost/api/settings', {
            method: 'PUT',
            headers: { origin: 'http://localhost', 'x-shuttle-settings': '1' },
            body: '{',
          }),
        )
      ).status,
    ).toBe(400);
    expect(harness.store.getRuntimeSettings().revision).toBe(0);
  });

  it('rejects a file/missing folder and never changes the existing output', async () => {
    const file = join(harness.dataDir, 'existing.txt');
    writeFileSync(file, 'preserve');
    for (const logFolder of [file, join(harness.dataDir, 'missing')]) {
      expect(
        (await PUT(request({ ...settingsFromConfig(harness.config), logFolder }))).status,
      ).toBe(400);
    }
    expect(readFileSync(file, 'utf8')).toBe('preserve');
  });

  it('rejects incomplete Snowflake setup and never exposes secrets', async () => {
    const settings = {
      ...settingsFromConfig(harness.config),
      logSink: 'snowflake',
      snowflake: {
        account: 'org-account',
        username: 'LOGGER',
        warehouse: 'WH',
        database: 'DB',
        schema: 'PUBLIC',
        role: '',
        table: 'EVENTS',
      },
    };
    const response = await PUT(request(settings));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain(
      'SNOWFLAKE_PRIVATE_KEY_PATH',
    );
    expect(JSON.stringify(await (await GET()).json())).not.toMatch(
      /privateKey|accessToken|clientSecret/,
    );
    expect(harness.store.getRuntimeSettings().revision).toBe(0);
  });

  it('applies file and chunk concurrency in a running worker on the next tick', async () => {
    // Force multi-part uploads and measure actual in-flight gateway requests.
    harness.cleanup();
    harness = await createHarness({ directUploadMaxBytes: 10, partSize: 8 });
    vi.mocked(getStore).mockReturnValue(harness.store);
    for (let i = 0; i < 5; i++) harness.writeSource(`file${i}.txt`, 'a'.repeat(40));
    const job = harness.store.createJob({
      profileId: harness.createProfile().id,
      operatorLabel: 'tester',
    });
    harness.store.enqueueCommand(job.id, 'START_JOB');
    await processCommands(harness.ctx);
    const runtime = harness.newRuntime();
    await runtime.tick(); // scan, while still using defaults
    let active = 0;
    let peak = 0;
    let changeSettings = true;
    const original = harness.gateway.uploadPart.bind(harness.gateway);
    vi.spyOn(harness.gateway, 'uploadPart').mockImplementation(async (req) => {
      active++;
      peak = Math.max(peak, active);
      if (changeSettings) {
        changeSettings = false;
        expect(
          (await PUT(request({ ...values, fileConcurrency: 2, chunkConcurrency: 2 }, 1))).status,
        ).toBe(200);
      }
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return await original(req);
      } finally {
        active--;
      }
    });
    const values = {
      ...settingsFromConfig(harness.config),
      fileConcurrency: 1,
      chunkConcurrency: 1,
      logFolder: harness.dataDir,
    };
    expect((await PUT(request(values))).status).toBe(200);
    await runtime.tick();
    expect(peak).toBe(1);
    peak = 0;
    await runtime.tick();
    expect(peak).toBe(2);
  });

  it('disables actual AI requests on an existing job', async () => {
    harness.writeSource('契約書.txt', '契約番号 LEG-42');
    const job = harness.store.createJob({
      profileId: harness.createProfile().id,
      operatorLabel: 'tester',
    });
    harness.store.enqueueCommand(job.id, 'START_JOB');
    expect(
      (
        await PUT(
          request({
            ...settingsFromConfig(harness.config),
            aiEnabled: false,
            logFolder: harness.dataDir,
          }),
        )
      ).status,
    ).toBe(200);
    const extract = vi.spyOn(harness.gateway, 'extractStructured');
    await runUntilIdle(harness);
    expect(extract).not.toHaveBeenCalled();
    const item = harness.store.listItems(job.id)[0]!;
    expect(harness.store.latestExtraction(item.id)).toBeNull();
    expect(['NEEDS_REVIEW', 'REVIEW_REQUIRED']).toContain(item.state);
    expect(item.boxFileId).toBeTruthy();
  });

  it('routes subsequent log batches into the selected folder without restarting the sender', async () => {
    const a = join(harness.dataDir, 'ログ A');
    const b = join(harness.dataDir, 'ログ B');
    mkdirSync(a);
    mkdirSync(b);
    const values = { ...settingsFromConfig(harness.config), logFolder: a };
    expect((await PUT(request(values))).status).toBe(200);
    const sink = new ConfiguredTelemetrySink(() => getConfig());
    const sender = new OutboxSender({ store: harness.store, sink, batchSize: 10 });
    const job = harness.store.createJob({
      profileId: harness.createProfile().id,
      operatorLabel: 'tester',
    });
    harness.store.appendEvent({ jobId: job.id, phase: 'SCAN', status: 'STARTED' });
    expect((await sender.runOnce()).delivered).toBe(1);
    expect((await PUT(request({ ...values, logFolder: b }, 1))).status).toBe(200);
    harness.store.appendEvent({ jobId: job.id, phase: 'SCAN', status: 'SUCCEEDED' });
    expect((await sender.runOnce()).delivered).toBe(1);
    expect(JSON.parse(readFileSync(join(a, 'events.jsonl'), 'utf8')).status).toBe('STARTED');
    expect(JSON.parse(readFileSync(join(b, 'events.jsonl'), 'utf8')).status).toBe('SUCCEEDED');
    await sender.close();
  });
});
