import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, approveItem, type Harness } from './harness';
import { AuthStore } from '@shuttle-lite/db';
import { ShuttleError } from '@shuttle-lite/core';
import { WorkerRuntime } from '../apps/worker/src/runtime';
import { processCommands } from '../apps/worker/src/commands';
import { processTestCleanup } from '../apps/worker/src/test-cleanup';
import type { WorkerContext } from '../apps/worker/src/context';
import { buildTelemetryPayload } from '@shuttle-lite/telemetry';

describe('worker user binding', () => {
  let a: Harness;
  let b: Harness;
  beforeEach(async () => {
    a = await createHarness();
    b = await createHarness();
    const auth = new AuthStore(a.store.db, 'ab'.repeat(32));
    for (const id of ['11', '22'])
      auth.saveUser(
        { id, name: id, login: `${id}@example.test`, enterpriseId: '99' },
        { accessToken: id, refreshToken: id, expiresAt: Date.now() + 3600_000 },
      );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    a.cleanup();
    b.cleanup();
  });

  it('uses the original user for transfer, AI, approval and placement across multiple jobs', async () => {
    a.writeSource('契約書.txt', '業務委託契約書 LEG-0042');
    const owners: Record<string, string> = {};
    const jobs = ['11', '22'].map((userId) => {
      const job = a.store.createJob({
        profileId: a.createProfile().id,
        operatorLabel: userId,
        ownerUserId: userId,
      });
      owners[job.id] = userId;
      a.store.enqueueCommand(job.id, 'START_JOB', {}, userId);
      return job;
    });
    const aUpload = vi.spyOn(a.gateway, 'uploadDirect');
    const bUpload = vi.spyOn(b.gateway, 'uploadDirect');
    const aAi = vi.spyOn(a.gateway, 'extractStructured');
    const bAi = vi.spyOn(b.gateway, 'extractStructured');
    const aMove = vi.spyOn(a.gateway, 'moveFile');
    const bMove = vi.spyOn(b.gateway, 'moveFile');
    const ctx: WorkerContext = {
      ...a.ctx,
      resolveJobContext: async (id) => {
        const selected = owners[id] === '11' ? a : b;
        return { config: selected.config, gateway: selected.gateway, layout: selected.ctx.layout };
      },
    };
    const runtime = new WorkerRuntime(ctx);
    await processCommands(ctx);
    for (let i = 0; i < 8; i++) await runtime.tick();
    expect(aUpload).toHaveBeenCalledTimes(1);
    expect(bUpload).toHaveBeenCalledTimes(1);
    expect(aAi).toHaveBeenCalledTimes(1);
    expect(bAi).toHaveBeenCalledTimes(1);
    for (const job of jobs) approveItem(a, a.store.listItems(job.id)[0]!, 'LEGAL_CONTRACTS');
    await processCommands(ctx);
    for (let i = 0; i < 8; i++) await runtime.tick();
    expect(aMove).toHaveBeenCalledTimes(1);
    expect(bMove).toHaveBeenCalledTimes(1);
    for (const job of jobs) {
      expect(a.store.getJob(job.id)?.state).toBe('COMPLETED');
      const finished = a.store
        .listEvents(job.id)
        .find(
          (event) => event.itemId && event.phase === 'FINAL_VERIFY' && event.status === 'SUCCEEDED',
        )!;
      expect(buildTelemetryPayload(finished)).toMatchObject({
        requestedByUserId: owners[job.id],
        executorUserId: owners[job.id],
        fileName: '契約書.txt',
      });
    }
  });

  it('pauses a lost grant and rejects commands and cleanup without touching another gateway', async () => {
    const job = a.store.createJob({
      profileId: a.createProfile().id,
      operatorLabel: '11',
      ownerUserId: '11',
      testMode: true,
    });
    a.store.setJobState(job.id, 'RUNNING');
    const upload = vi.spyOn(a.gateway, 'uploadDirect');
    const folder = vi.spyOn(a.gateway, 'ensureFolder');
    const remove = vi.spyOn(a.gateway, 'deleteTestFile');
    const ctx: WorkerContext = {
      ...a.ctx,
      resolveJobContext: async () => {
        throw new ShuttleError('BOX_AUTH', '再ログインしてください');
      },
    };
    await new WorkerRuntime(ctx).tick();
    expect(a.store.getJob(job.id)?.state).toBe('PAUSED');
    a.store.enqueueCommand(job.id, 'RESUME_JOB', {}, '11');
    await processCommands(ctx);
    expect(a.store.listCommands(job.id)[0]?.state).toBe('REJECTED');
    a.store.requestTestCleanup(job.id);
    await processTestCleanup(ctx);
    expect(a.store.getJob(job.id)?.cleanupState).toBe('FAILED');
    expect(upload).not.toHaveBeenCalled();
    expect(folder).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('never executes an OAuth-owned job after switching back to common-account mode', async () => {
    const job = a.store.createJob({
      profileId: a.createProfile().id,
      operatorLabel: '11',
      ownerUserId: '11',
    });
    a.store.setJobState(job.id, 'RUNNING');
    const folder = vi.spyOn(a.gateway, 'ensureFolder');
    await new WorkerRuntime(a.ctx).tick();
    expect(a.store.getJob(job.id)?.lastErrorCategory).toBe('BOX_AUTH');
    expect(folder).not.toHaveBeenCalled();
  });
});
