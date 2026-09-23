import { applyRuntimeSettings } from '@shuttle-lite/config';
import { ensureJobStagingFolder } from '@shuttle-lite/box';
import { type ItemState, Semaphore, sleep, toShuttleError } from '@shuttle-lite/core';
import { processCommands } from './commands';
import { processTestCleanup } from './test-cleanup';
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
  #leaseLost = false;
  #settingsRevision = 0;
  #ticking = false;

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
    this.#ctx.store.heartbeat(this.#ctx.workerId);
    const heartbeat = setInterval(() => {
      try {
        this.#ctx.store.heartbeat(this.#ctx.workerId);
      } catch {
        this.requestStop();
      }
    }, 5_000);
    heartbeat.unref();
    try {
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
    } finally {
      clearInterval(heartbeat);
      this.#releaseCurrentJob();
      this.#ctx.store.removeHeartbeat(this.#ctx.workerId);
    }
  }

  /** Returns true when the tick did something, so the loop can poll faster. */
  async tick(): Promise<boolean> {
    if (this.#ticking) throw new Error('worker tick is already running');
    if (this.#stopping) return false;
    this.#ticking = true;
    try {
      return await this.#tick();
    } finally {
      this.#ticking = false;
    }
  }

  async #tick(): Promise<boolean> {
    const settings = this.#ctx.store.getRuntimeSettings();
    this.#settingsRevision = settings.revision;
    const config = applyRuntimeSettings(this.#baseConfig, settings.settings);
    this.#ctx = {
      ...this.#ctx,
      config,
      fileGate: new Semaphore(config.limits.fileConcurrency),
      chunkGate: new Semaphore(config.limits.chunkConcurrency),
    };
    if (await processTestCleanup(this.#ctx)) return true;
    const leaseTtl = this.#options.leaseTtlMs ?? 30_000;
    const claimed = this.#ctx.store.claimJob(this.#ctx.workerId, leaseTtl);
    if (!claimed) return false;
    this.#currentJobId = claimed.id;
    this.#leaseLost = false;
    // Keep ownership during slow uploads/AI calls, including setup and scan.
    const heartbeat = setInterval(
      () => {
        if (this.#leaseLost) return;
        try {
          if (!this.#ctx.store.renewLease(claimed.id, this.#ctx.workerId, leaseTtl)) {
            this.#leaseLost = true;
          }
        } catch {
          this.#leaseLost = true;
        }
      },
      Math.max(1, Math.floor(leaseTtl / 3)),
    );
    heartbeat.unref();
    try {
      return await this.#runJob(claimed.id);
    } finally {
      clearInterval(heartbeat);
      // All in-flight steps settle before another worker or cleanup can enter.
      this.#releaseCurrentJob();
    }
  }

  async #runJob(jobId: string): Promise<boolean> {
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

    const progressed = await this.#runQueues(ctx);
    if (!this.#shouldYield(job.id)) this.#maybeFinishJob(ctx);
    return progressed;
  }

  #shouldYield(jobId: string): boolean {
    const job = this.#ctx.store.getJob(jobId);
    return (
      this.#stopping ||
      this.#leaseLost ||
      !job ||
      job.leaseOwner !== this.#ctx.workerId ||
      !job.leaseExpiresAt ||
      Date.parse(job.leaseExpiresAt) <= Date.now() ||
      job.pauseRequested ||
      job.cleanupState !== 'NONE' ||
      job.state !== 'RUNNING' ||
      this.#ctx.store.getRuntimeSettings().revision !== this.#settingsRevision ||
      // Commands run after active steps settle, so rescan/skip/retry cannot
      // change an item underneath an upload or an AI response.
      this.#ctx.store.hasOutstandingCommands(jobId)
    );
  }

  async #runQueues(ctx: JobContext): Promise<boolean> {
    const queues = [
      { scope: TRANSFER_SCOPE, limit: ctx.config.limits.fileConcurrency, active: 0 },
      { scope: ROUTING_SCOPE, limit: this.#options.routingConcurrency ?? 2, active: 0 },
      { scope: PLACEMENT_SCOPE, limit: 2, active: 0 },
    ];
    const inFlight = new Map<string, Promise<void>>();
    let progressed = false;
    let draining = false;
    let yielding = false;
    let failed = false;
    let failure: unknown;
    let wake: (() => void) | undefined;
    const shouldStop = () => draining || failed || (yielding ||= this.#shouldYield(ctx.job.id));
    try {
      while (true) {
        if (failed) throw failure;
        if (!shouldStop()) {
          for (const queue of queues) {
            const available = queue.limit - queue.active;
            if (available <= 0) continue;
            // Active rows still have a runnable state. Read past them without
            // picking one item twice, even while it changes pipeline stages.
            const ready = ctx.store
              .listReadyItemsForScope(ctx.job.id, queue.scope, available + inFlight.size)
              .filter((item) => !inFlight.has(item.id))
              .slice(0, available);
            for (const item of ready) {
              queue.active += 1;
              const work = async () => {
                for (let step = 0; step < queue.scope.length + 2; step += 1) {
                  if (shouldStop()) return;
                  if ((await advanceItem(ctx, item.id, queue.scope)) !== 'ADVANCED') return;
                  progressed = true;
                }
              };
              const task = work()
                .catch((error: unknown) => {
                  if (!failed) failure = error;
                  failed = true;
                })
                .finally(() => {
                  queue.active -= 1;
                  inFlight.delete(item.id);
                  wake?.();
                });
              inFlight.set(item.id, task);
            }
          }
        }
        if (inFlight.size === 0) break;
        // Any completion frees a slot; neither a large file nor a slow AI
        // request holds the other queues at a batch barrier.
        // One completion signal avoids retaining a new Promise.race handler
        // on a long upload for every small file. Poll also wakes due retries.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.max(10, this.#options.idleDelayMs ?? 500));
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake = undefined;
      }
    } finally {
      draining = true;
      await Promise.allSettled(inFlight.values());
    }
    return progressed;
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
