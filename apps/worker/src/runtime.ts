import { applyRuntimeSettings } from '@shuttle-lite/config';
import { ensureJobStagingFolder } from '@shuttle-lite/box';
import {
  type ItemState,
  type MigrationItem,
  Semaphore,
  sleep,
  toShuttleError,
} from '@shuttle-lite/core';
import { processCommands } from './commands';
import { destinationsForJob, type JobContext, type WorkerContext } from './context';
import { advanceItem, PLACEMENT_SCOPE, ROUTING_SCOPE, TRANSFER_SCOPE } from './pipeline';
import { reconcileJob } from './reconcile';
import { LocalSourceAdapter } from './source/local';
import { scanSource } from './steps/source';

export interface RuntimeOptions {
  readonly leaseTtlMs?: number;
  readonly idleDelayMs?: number;
  readonly routingConcurrency?: number;
}

const TERMINAL_STATES: readonly ItemState[] = ['COMPLETED', 'SKIPPED', 'FAILED'];
const WAITING_FOR_HUMAN: readonly ItemState[] = ['REVIEW_REQUIRED', 'NEEDS_REVIEW'];

/**
 * One worker process, one job at a time. The job lease prevents a second
 * worker from touching the same job, and every tick re-reads the job row so a
 * pause request takes effect promptly.
 */
export class WorkerRuntime {
  #ctx: WorkerContext;
  readonly #baseConfig: WorkerContext['config'];
  readonly #options: RuntimeOptions;
  readonly #reconciled = new Set<string>();
  #stopping = false;
  #currentJobId: string | null = null;

  constructor(ctx: WorkerContext, options: RuntimeOptions = {}) {
    this.#ctx = ctx;
    this.#baseConfig = ctx.config;
    this.#options = options;
  }

  get stopping(): boolean {
    return this.#stopping;
  }

  requestStop(): void {
    this.#stopping = true;
  }

  async run(): Promise<void> {
    const idle = this.#options.idleDelayMs ?? 500;
    while (!this.#stopping) {
      let worked = false;
      try {
        worked = (await processCommands(this.#ctx)) > 0;
        worked = (await this.tick()) || worked;
      } catch (error) {
        const shuttleError = toShuttleError(error);
        this.#ctx.logger.error('worker tick failed', {
          category: shuttleError.category,
          message: shuttleError.message,
        });
      }
      if (!worked) await sleep(idle);
    }
    this.#releaseCurrentJob();
  }

  /** Returns true when the tick did something, so the loop can poll faster. */
  async tick(): Promise<boolean> {
    const config = applyRuntimeSettings(
      this.#baseConfig,
      this.#ctx.store.getRuntimeSettings().settings,
    );
    this.#ctx = {
      ...this.#ctx,
      config,
      fileGate: new Semaphore(config.limits.fileConcurrency),
      chunkGate: new Semaphore(config.limits.chunkConcurrency),
    };
    const leaseTtl = this.#options.leaseTtlMs ?? 30_000;
    const claimed = this.#ctx.store.claimJob(this.#ctx.workerId, leaseTtl);
    if (!claimed) return false;
    this.#currentJobId = claimed.id;
    try {
      return await this.#runJob(claimed.id, leaseTtl);
    } finally {
      // The lease is always handed back, including on an early return, so the
      // next tick (or another worker) can pick the job up again.
      this.#releaseCurrentJob();
    }
  }

  async #runJob(jobId: string, leaseTtl: number): Promise<boolean> {
    const job = this.#ctx.store.getJob(jobId);
    if (!job) return false;
    const profile = this.#ctx.store.getProfile(job.profileId);
    if (!profile) {
      this.#ctx.store.setJobState(job.id, 'FAILED', {
        lastError: 'profileが存在しません',
        lastErrorCategory: 'CONFIG_INVALID',
      });
      return true;
    }

    if (job.pauseRequested) {
      if (job.state !== 'PAUSED') {
        this.#ctx.store.setJobState(job.id, 'PAUSED');
        this.#ctx.logger.info('jobをpauseしました', { jobId: job.id });
      }
      return true;
    }

    if (job.state === 'QUEUED') {
      // Waiting for an explicit START_JOB command from the UI.
      return false;
    }

    let destinations: Pick<WorkerContext, 'catalog' | 'layout'>;
    try {
      destinations = destinationsForJob(this.#ctx, job.id);
    } catch (error) {
      const failure = toShuttleError(error);
      this.#ctx.store.setJobState(job.id, 'PAUSED', {
        pauseRequested: true,
        lastError: failure.message,
        lastErrorCategory: failure.category,
      });
      return true;
    }

    const stagingFolderId = await ensureJobStagingFolder(
      this.#ctx.gateway,
      this.#ctx.layout,
      job.id,
    );
    if (job.stagingFolderId !== stagingFolderId) {
      this.#ctx.store.setJobState(job.id, job.state, { stagingFolderId });
    }

    const ctx: JobContext = {
      ...this.#ctx,
      ...destinations,
      job,
      profile,
      source: new LocalSourceAdapter({ rootPath: profile.sourceRootPath }),
      stagingFolderId,
      telemetry: profile.snowflakeLoggingEnabled,
      aiEnabled: profile.aiRoutingEnabled && this.#ctx.config.ai.enabled,
    };

    if (!this.#reconciled.has(job.id)) {
      const summary = await reconcileJob(ctx);
      this.#reconciled.add(job.id);
      if (summary.inspected > 0) {
        this.#ctx.logger.info('起動時reconciliation完了', { jobId: job.id, ...summary });
      }
    }

    if (job.state === 'SCANNING') {
      const summary = await scanSource(ctx);
      this.#ctx.logger.info('scan完了', { jobId: job.id, ...summary });
      this.#ctx.store.appendEvent(
        {
          jobId: job.id,
          phase: 'SCAN',
          status: 'SUCCEEDED',
          sizeBytes: summary.totalBytes,
          message: `scan: 新規${summary.inserted} 変更${summary.rescanned} 既存${summary.unchanged}`,
        },
        { telemetry: ctx.telemetry },
      );
      this.#ctx.store.setJobState(job.id, 'RUNNING');
      return true;
    }

    this.#ctx.store.renewLease(job.id, this.#ctx.workerId, leaseTtl);

    // Upload work and AI work progress independently: a file waiting for a
    // document representation must not hold up another file's transfer.
    const [transferred, routed, placed] = await Promise.all([
      this.#drainQueue(
        ctx,
        TRANSFER_SCOPE,
        this.#ctx.config.limits.fileConcurrency,
        this.#ctx.fileGate,
      ),
      this.#drainQueue(ctx, ROUTING_SCOPE, this.#options.routingConcurrency ?? 2),
      this.#drainQueue(ctx, PLACEMENT_SCOPE, 2),
    ]);

    const progressed = transferred + routed + placed > 0;
    if (!progressed) this.#maybeFinishJob(ctx);
    return progressed;
  }

  async #drainQueue(
    ctx: JobContext,
    scope: readonly ItemState[],
    concurrency: number,
    gate?: { withPermit<T>(fn: () => Promise<T>): Promise<T> },
  ): Promise<number> {
    const batch = ctx.store.listReadyItemsForScope(ctx.job.id, scope, concurrency);
    if (batch.length === 0) return 0;
    let processed = 0;
    await Promise.all(
      batch.map((item: MigrationItem) => {
        const work = async () => {
          // Walk this item as far as the queue's scope allows.
          for (let steps = 0; steps < scope.length + 2; steps += 1) {
            if (this.#stopping) return;
            const result = await advanceItem(ctx, item.id, scope);
            if (result === 'ADVANCED') {
              processed += 1;
              continue;
            }
            return;
          }
        };
        return gate ? gate.withPermit(work) : work();
      }),
    );
    return processed;
  }

  #maybeFinishJob(ctx: JobContext): void {
    const total = ctx.store.countItemsByState(ctx.job.id);
    const counts = Object.entries(total);
    if (counts.length === 0) {
      // An empty source root still has to reach a terminal job state.
      ctx.store.setJobState(ctx.job.id, 'COMPLETED', { finishedAt: new Date().toISOString() });
      ctx.store.appendEvent(
        {
          jobId: ctx.job.id,
          phase: 'SCAN',
          status: 'SUCCEEDED',
          message: '対象fileがありませんでした',
        },
        { telemetry: ctx.telemetry },
      );
      return;
    }
    const terminal = counts
      .filter(([state]) => TERMINAL_STATES.includes(state as ItemState))
      .reduce((sum, [, count]) => sum + count, 0);
    const all = counts.reduce((sum, [, count]) => sum + count, 0);
    const waiting = ctx.store.countByStates(ctx.job.id, WAITING_FOR_HUMAN);

    if (terminal === all && all > 0) {
      ctx.store.setJobState(ctx.job.id, 'COMPLETED', { finishedAt: new Date().toISOString() });
      ctx.store.appendEvent(
        {
          jobId: ctx.job.id,
          phase: 'FINAL_VERIFY',
          status: 'SUCCEEDED',
          message: `job完了: ${total.COMPLETED ?? 0}件完了 / ${total.FAILED ?? 0}件失敗 / ${total.SKIPPED ?? 0}件skip`,
        },
        { telemetry: ctx.telemetry },
      );
      this.#ctx.logger.info('job完了', { jobId: ctx.job.id, counts: total });
      return;
    }
    if (waiting > 0) {
      this.#ctx.logger.debug('review待ちのためjobは継続中', { jobId: ctx.job.id, waiting });
    }
  }

  #releaseCurrentJob(): void {
    if (!this.#currentJobId) return;
    this.#ctx.store.releaseLease(this.#currentJobId, this.#ctx.workerId);
    this.#currentJobId = null;
  }
}
