import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ensureBoxLayout, ensureJobStagingFolder, FakeBoxGateway } from '@shuttle-lite/box';
import {
  buildConfig,
  loadDestinationCatalog,
  parseEnv,
  type AppConfig,
  type DestinationCatalogConfig,
} from '@shuttle-lite/config';
import {
  createLogger,
  type MigrationItem,
  type MigrationProfile,
  Semaphore,
  sha1Buffer,
} from '@shuttle-lite/core';
import { migrate, openDatabase, ShuttleStore } from '@shuttle-lite/db';
import { buildTelemetryPayload } from '@shuttle-lite/telemetry';
import type { JobContext, WorkerContext } from '../apps/worker/src/context';
import { processCommands } from '../apps/worker/src/commands';
import { advanceItem } from '../apps/worker/src/pipeline';
import { WorkerRuntime } from '../apps/worker/src/runtime';
import { LocalSourceAdapter } from '../apps/worker/src/source/local';
import { scanSource } from '../apps/worker/src/steps/source';

export interface Harness {
  readonly ctx: WorkerContext;
  /** Builds the per-job context the worker uses, for step level tests. */
  jobContext(jobId: string): Promise<JobContext>;
  /** Scans and hashes only, leaving items at PREFLIGHT. */
  scanAndHash(jobId: string): Promise<void>;
  readonly config: AppConfig;
  readonly store: ShuttleStore;
  readonly gateway: FakeBoxGateway;
  readonly catalog: DestinationCatalogConfig;
  readonly sourceRoot: string;
  readonly dataDir: string;
  newRuntime(): WorkerRuntime;
  writeSource(relativePath: string, content: string | Buffer): { sha1: string; size: number };
  createProfile(overrides?: Partial<MigrationProfile>): MigrationProfile;
  cleanup(): void;
}

export interface HarnessOptions {
  readonly directUploadMaxBytes?: number;
  readonly partSize?: number;
  readonly aiPendingFirstCall?: boolean;
  readonly rateLimitEvery?: number;
  readonly maxAttempts?: number;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), 'shuttle-e2e-'));
  const sourceRoot = join(dataDir, 'source');
  mkdirSync(sourceRoot, { recursive: true });

  const config = buildConfig(
    parseEnv({
      NODE_ENV: 'test',
      BOX_MODE: 'fake',
      SHUTTLE_DATA_DIR: dataDir,
      SQLITE_PATH: join(dataDir, 'shuttle.db'),
      LOG_LEVEL: 'error',
      DIRECT_UPLOAD_MAX_BYTES: String(options.directUploadMaxBytes ?? 512 * 1024),
      MAX_ATTEMPTS: String(options.maxAttempts ?? 3),
      FILE_CONCURRENCY: '3',
      CHUNK_CONCURRENCY: '3',
    } as NodeJS.ProcessEnv),
  );

  const db = openDatabase({ path: config.sqlitePath });
  migrate(db);
  const store = new ShuttleStore(db, { telemetryPayload: buildTelemetryPayload });

  const gateway = new FakeBoxGateway({
    rootDir: config.fakeBox.rootDir,
    maxFileBytes: config.limits.maxFileBytes,
    partSize: options.partSize ?? 256 * 1024,
    aiPendingFirstCall: options.aiPendingFirstCall ?? false,
    rateLimitEvery: options.rateLimitEvery ?? 0,
  });

  const catalog = loadDestinationCatalog();
  const layout = await ensureBoxLayout(gateway, config, catalog);

  const ctx: WorkerContext = {
    config,
    store,
    gateway,
    catalog,
    layout,
    logger: createLogger('error'),
    fileGate: new Semaphore(config.limits.fileConcurrency),
    chunkGate: new Semaphore(config.limits.chunkConcurrency),
    workerId: 'test-worker',
  };

  const jobContext = async (jobId: string): Promise<JobContext> => {
    const job = store.getJob(jobId);
    if (!job) throw new Error(`job not found: ${jobId}`);
    const profile = store.getProfile(job.profileId);
    if (!profile) throw new Error(`profile not found: ${job.profileId}`);
    const stagingFolderId = await ensureJobStagingFolder(gateway, layout, job.id);
    if (job.stagingFolderId !== stagingFolderId) {
      store.setJobState(job.id, job.state, { stagingFolderId });
    }
    return {
      ...ctx,
      job: store.getJob(jobId)!,
      profile,
      source: new LocalSourceAdapter({ rootPath: profile.sourceRootPath }),
      stagingFolderId,
      telemetry: profile.snowflakeLoggingEnabled,
      aiEnabled: profile.aiRoutingEnabled && config.ai.enabled,
    };
  };

  return {
    ctx,
    config,
    store,
    gateway,
    catalog,
    sourceRoot,
    dataDir,
    jobContext,
    async scanAndHash(jobId) {
      const jobCtx = await jobContext(jobId);
      await scanSource(jobCtx);
      for (const item of store.listItems(jobId)) {
        await advanceItem(jobCtx, item.id, ['DISCOVERED', 'HASHING']);
      }
    },
    newRuntime: () => new WorkerRuntime(ctx, { leaseTtlMs: 60_000, idleDelayMs: 1 }),
    writeSource(relativePath, content) {
      const absolute = join(sourceRoot, relativePath);
      mkdirSync(dirname(absolute), { recursive: true });
      const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
      writeFileSync(absolute, buffer);
      return { sha1: sha1Buffer(buffer), size: buffer.byteLength };
    },
    createProfile(overrides = {}) {
      return store.createProfile({
        name: overrides.name ?? `profile-${Math.random().toString(36).slice(2)}`,
        sourceRootPath: overrides.sourceRootPath ?? sourceRoot,
        targetStagingFolderId: layout.stagingRootFolderId,
        destinationCatalogId: catalog.id,
        proxyProfileName: 'none',
        metadataTemplateKey: config.box.metadataTemplateKey,
        fileConcurrency: overrides.fileConcurrency ?? 3,
        chunkConcurrency: overrides.chunkConcurrency ?? 3,
        aiRoutingEnabled: overrides.aiRoutingEnabled ?? true,
        snowflakeLoggingEnabled: overrides.snowflakeLoggingEnabled ?? true,
        conflictPolicy: overrides.conflictPolicy ?? 'RENAME',
      });
    },
    cleanup() {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Drives the worker the way the real loop does, until it stops making progress. */
export async function runUntilIdle(harness: Harness, maxTicks = 200): Promise<number> {
  const runtime = harness.newRuntime();
  let ticks = 0;
  let idleStreak = 0;
  while (ticks < maxTicks && idleStreak < 2) {
    const commands = await processCommands(harness.ctx);
    const worked = await runtime.tick();
    ticks += 1;
    idleStreak = commands === 0 && !worked ? idleStreak + 1 : 0;
  }
  return ticks;
}

export function approveItem(
  harness: Harness,
  item: MigrationItem,
  destinationKey: string,
  operatorLabel = 'tester (local)',
  finalName: string | null = null,
): void {
  harness.store.enqueueCommand(item.jobId, 'APPROVE_ITEM', {
    ...(harness.store.getJobMetadata(item.jobId)
      ? { business: harness.store.getBusinessMetadata(item.id) }
      : {}),
    itemId: item.id,
    destinationKey,
    operatorLabel,
    observedBoxFileId: item.boxFileId,
    observedSha1: item.boxSha1,
    observedVersionId: item.boxFileVersionId,
    finalName,
    metadata: {},
  });
}
