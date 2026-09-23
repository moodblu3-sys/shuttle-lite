import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settingsFromConfig } from '@shuttle-lite/config';
import { ShuttleError } from '@shuttle-lite/core';
import { processCommands } from '../apps/worker/src/commands';
import { WorkerRuntime } from '../apps/worker/src/runtime';
import { approveItem, createHarness, runUntilIdle, type Harness } from './harness';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('continuous worker queues', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    h.cleanup();
  });

  function concurrency(files: number, chunks = 2) {
    h.store.saveRuntimeSettings(
      {
        ...settingsFromConfig(h.config),
        fileConcurrency: files,
        chunkConcurrency: chunks,
      },
      h.store.getRuntimeSettings().revision,
    );
  }

  async function start(names: string[], runtime = h.newRuntime()) {
    for (const name of names) h.writeSource(name, '業務委託契約書 契約番号 LEG-0042');
    const job = h.store.createJob({ profileId: h.createProfile().id, operatorLabel: 'test' });
    h.store.enqueueCommand(job.id, 'START_JOB');
    await processCommands(h.ctx);
    await runtime.tick();
    return { job, runtime };
  }

  it('refills a free file slot while another file is still uploading, without duplicate work', async () => {
    concurrency(2);
    const { job, runtime } = await start(['a.txt', 'b.txt', 'c.txt', 'd.txt']);
    const slow = deferred();
    const started: string[] = [];
    let active = 0;
    let peak = 0;
    const upload = h.gateway.uploadDirect.bind(h.gateway);
    vi.spyOn(h.gateway, 'uploadDirect').mockImplementation(async (input) => {
      started.push(input.name);
      peak = Math.max(peak, ++active);
      try {
        if (input.name.endsWith('a.txt')) await slow.promise;
        return await upload(input);
      } finally {
        active--;
      }
    });
    const tick = runtime.tick();
    try {
      await vi.waitFor(() => expect(started.some((name) => name.endsWith('d.txt'))).toBe(true));
      expect(h.store.listItems(job.id).find((item) => item.sourceFileName === 'a.txt')?.state).toBe(
        'UPLOADING',
      );
      expect(peak).toBe(2);
    } finally {
      slow.resolve();
      await tick;
    }
    expect(started).toHaveLength(4);
    expect(new Set(started).size).toBe(4);
    expect(h.store.listItems(job.id).every((item) => item.state === 'REVIEW_REQUIRED')).toBe(true);
  });

  it('keeps transferring and placing approved files while both AI slots are occupied', async () => {
    concurrency(1);
    const { job, runtime } = await start(['approved.txt']);
    await runtime.tick();
    const approved = h.store.listItems(job.id)[0]!;
    approveItem(h, approved, 'LEGAL_CONTRACTS');
    for (let i = 0; i < 5; i++) h.writeSource(`new${i}.txt`, '業務委託契約書 LEG-0042');
    h.store.enqueueCommand(job.id, 'RESCAN_JOB');
    await processCommands(h.ctx);
    await runtime.tick();

    const ai = deferred();
    const extract = h.gateway.extractStructured.bind(h.gateway);
    let active = 0;
    let peak = 0;
    const seen: string[] = [];
    vi.spyOn(h.gateway, 'extractStructured').mockImplementation(async (input) => {
      seen.push(input.fileId);
      peak = Math.max(peak, ++active);
      try {
        await ai.promise;
        return await extract(input);
      } finally {
        active--;
      }
    });
    const tick = runtime.tick();
    try {
      await vi.waitFor(() => {
        expect(h.store.listItems(job.id).every((item) => item.boxFileId !== null)).toBe(true);
        expect(h.store.getItem(approved.id)?.state).toBe('COMPLETED');
      });
      expect(active).toBe(2);
      expect(seen).toHaveLength(2);
    } finally {
      ai.resolve();
      await tick;
    }
    expect(peak).toBe(2);
    expect(new Set(seen).size).toBe(5);
    expect(seen).toHaveLength(5);
  });

  it('starts the next AI task without waiting for a slow AI task in the other slot', async () => {
    const { runtime } = await start(['a.txt', 'b.txt', 'c.txt']);
    const slow = deferred();
    const seen: string[] = [];
    const extract = h.gateway.extractStructured.bind(h.gateway);
    vi.spyOn(h.gateway, 'extractStructured').mockImplementation(async (input) => {
      seen.push(input.fileName!);
      if (input.fileName === 'a.txt') await slow.promise;
      return extract(input);
    });
    const tick = runtime.tick();
    try {
      await vi.waitFor(() => expect(seen).toContain('c.txt'));
    } finally {
      slow.resolve();
      await tick;
    }
    expect(seen).toHaveLength(3);
  });

  it('wakes a due upload retry while AI is still pending, honoring the retry delay', async () => {
    concurrency(1);
    const { job, runtime } = await start(['a.txt', 'b.txt']);
    const slowAI = deferred();
    const extract = h.gateway.extractStructured.bind(h.gateway);
    vi.spyOn(h.gateway, 'extractStructured').mockImplementation(async (input) => {
      await slowAI.promise;
      return extract(input);
    });
    const upload = h.gateway.uploadDirect.bind(h.gateway);
    const attempts: number[] = [];
    vi.spyOn(h.gateway, 'uploadDirect').mockImplementation(async (input) => {
      if (input.name.endsWith('b.txt')) {
        attempts.push(Date.now());
        if (attempts.length === 1) {
          throw new ShuttleError('BOX_RATE_LIMIT', 'synthetic rate limit', { retryAfterMs: 100 });
        }
      }
      return upload(input);
    });
    const tick = runtime.tick();
    try {
      await vi.waitFor(() => {
        expect(attempts).toHaveLength(2);
        expect(h.store.listItems(job.id).every((item) => item.boxFileId !== null)).toBe(true);
      });
      expect(attempts[1]! - attempts[0]!).toBeGreaterThanOrEqual(100);
    } finally {
      slowAI.resolve();
      await tick;
    }
  });

  it('keeps ownership until other active requests settle after a scheduler failure', async () => {
    concurrency(2);
    const { job, runtime } = await start(['a.txt', 'b.txt', 'c.txt']);
    const slow = deferred();
    const upload = h.gateway.uploadDirect.bind(h.gateway);
    const ready = h.store.listReadyItemsForScope.bind(h.store);
    const failure = new Error('synthetic database read failure');
    let uploadStarted = false;
    let injected = false;
    let settled = false;
    vi.spyOn(h.gateway, 'uploadDirect').mockImplementation(async (input) => {
      if (input.name.endsWith('a.txt')) {
        uploadStarted = true;
        await slow.promise;
      }
      return upload(input);
    });
    vi.spyOn(h.store, 'listReadyItemsForScope').mockImplementation((...args) => {
      if (uploadStarted && !injected) {
        injected = true;
        throw failure;
      }
      return ready(...args);
    });
    const result = runtime
      .tick()
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    try {
      await vi.waitFor(() => expect(injected).toBe(true));
      expect(settled).toBe(false);
      expect(h.store.claimJob('other-worker', 60_000)).toBeNull();
    } finally {
      slow.resolve();
    }
    expect(await result).toBe(failure);
    expect(h.store.getJob(job.id)?.leaseOwner).toBeNull();
  });

  it('drains an active step before pause, then resumes without uploading it again', async () => {
    concurrency(1);
    const { job, runtime } = await start(['a.txt', 'b.txt']);
    const slow = deferred();
    const upload = h.gateway.uploadDirect.bind(h.gateway);
    const spy = vi.spyOn(h.gateway, 'uploadDirect').mockImplementationOnce(async (input) => {
      await slow.promise;
      return upload(input);
    });
    const tick = runtime.tick();
    try {
      await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
      h.store.enqueueCommand(job.id, 'PAUSE_JOB');
      expect(h.store.getJob(job.id)?.leaseOwner).toBe(h.ctx.workerId);
    } finally {
      slow.resolve();
      await tick;
    }
    expect(spy).toHaveBeenCalledTimes(1);
    expect(h.store.getJob(job.id)?.leaseOwner).toBeNull();
    await processCommands(h.ctx);
    await runtime.tick();
    expect(h.store.getJob(job.id)?.state).toBe('PAUSED');
    h.store.enqueueCommand(job.id, 'RESUME_JOB');
    await runUntilIdle(h);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(h.store.listItems(job.id).every((item) => item.state === 'REVIEW_REQUIRED')).toBe(true);
  });

  it('renews the job lease during a slow request so another worker cannot duplicate it', async () => {
    const runtime = new WorkerRuntime(h.ctx, { leaseTtlMs: 120 });
    const { job } = await start(['a.txt'], runtime);
    const slow = deferred();
    const upload = h.gateway.uploadDirect.bind(h.gateway);
    const spy = vi.spyOn(h.gateway, 'uploadDirect').mockImplementationOnce(async (input) => {
      await slow.promise;
      return upload(input);
    });
    const tick = runtime.tick();
    try {
      await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce());
      const originalExpiry = h.store.getJob(job.id)!.leaseExpiresAt!;
      await vi.waitFor(() => {
        expect(Date.now()).toBeGreaterThan(Date.parse(originalExpiry));
        expect(Date.parse(h.store.getJob(job.id)!.leaseExpiresAt!)).toBeGreaterThan(Date.now());
      });
      expect(h.store.claimJob('second-worker', 120)).toBeNull();
    } finally {
      slow.resolve();
      await tick;
    }
    expect(h.store.getJob(job.id)?.leaseOwner).toBeNull();
  });

  it('stops dispatching when ownership is lost and does not release the new owner’s lease', async () => {
    concurrency(1);
    const { job, runtime } = await start(['a.txt', 'b.txt']);
    const slow = deferred();
    const upload = h.gateway.uploadDirect.bind(h.gateway);
    const spy = vi.spyOn(h.gateway, 'uploadDirect').mockImplementationOnce(async (input) => {
      await slow.promise;
      return upload(input);
    });
    const tick = runtime.tick();
    try {
      await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce());
      h.store.db
        .prepare('UPDATE migration_jobs SET lease_owner = ? WHERE id = ?')
        .run('new-owner', job.id);
    } finally {
      slow.resolve();
      await tick;
    }
    expect(spy).toHaveBeenCalledOnce();
    expect(h.store.getJob(job.id)?.leaseOwner).toBe('new-owner');
  });

  it('waits for the running upload when stopping and leaves queued files for restart', async () => {
    concurrency(1);
    const { job, runtime } = await start(['a.txt', 'b.txt']);
    const slow = deferred();
    const upload = h.gateway.uploadDirect.bind(h.gateway);
    const spy = vi.spyOn(h.gateway, 'uploadDirect').mockImplementationOnce(async (input) => {
      await slow.promise;
      return upload(input);
    });
    const running = runtime.run();
    try {
      await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce());
      runtime.requestStop();
      expect(h.store.getJob(job.id)?.leaseOwner).toBe(h.ctx.workerId);
    } finally {
      runtime.requestStop();
      slow.resolve();
      await running;
    }
    expect(spy).toHaveBeenCalledOnce();
    expect(h.store.getJob(job.id)?.leaseOwner).toBeNull();
    await runUntilIdle(h);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
