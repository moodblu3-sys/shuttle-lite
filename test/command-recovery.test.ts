import { readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildJobSnapshot } from '@shuttle-lite/telemetry';
import { processCommands } from '../apps/worker/src/commands';
import { approveItem, createHarness, runUntilIdle, type Harness } from './harness';

let h: Harness;
let jobId: string;
beforeEach(async () => {
  h = await createHarness();
  jobId = h.store.createJob({ profileId: h.createProfile().id, operatorLabel: 'tester' }).id;
});
afterEach(() => {
  vi.restoreAllMocks();
  h.cleanup();
});
function expireClaims() {
  h.store.db
    .prepare(
      "UPDATE job_commands SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE state = 'CLAIMED'",
    )
    .run();
}

describe('recoverable commands', () => {
  it('recovers an interrupted start once, after its lease expires', async () => {
    const command = h.store.enqueueCommand(jobId, 'START_JOB');
    h.store.claimCommands(); // Worker died before applying the command.
    expect(await processCommands(h.ctx)).toBe(0);
    expireClaims();
    expect(await processCommands(h.ctx)).toBe(1);
    expect(h.store.getJob(jobId)?.state).toBe('SCANNING');
    expect(h.store.listCommands(jobId).find((c) => c.id === command.id)?.state).toBe('DONE');
    expect(await processCommands(h.ctx)).toBe(0);
    expect(h.store.listEvents(jobId).filter((e) => e.status === 'STARTED')).toHaveLength(1);
  });

  it('fences a stale worker after recovery and does not let it renew ownership', () => {
    h.store.enqueueCommand(jobId, 'START_JOB');
    const old = h.store.claimCommands()[0]!;
    expireClaims();
    const recovered = h.store.claimCommands()[0]!;
    expect(recovered.claimToken).not.toBe(old.claimToken);
    const action = vi.fn();
    expect(h.store.withCommandClaim(old, action)).toBe(false);
    h.store.renewCommandClaims([old]);
    expect(action).not.toHaveBeenCalled();
    expect(h.store.withCommandClaim(recovered, () => h.store.completeCommand(recovered.id))).toBe(
      true,
    );
  });

  it('renews a live claim and prevents a second worker from overtaking it for the same job', () => {
    h.store.enqueueCommand(jobId, 'START_JOB');
    const command = h.store.claimCommands(1)[0]!;
    h.store.enqueueCommand(jobId, 'PAUSE_JOB');
    h.store.db
      .prepare('UPDATE job_commands SET lease_expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() + 1000).toISOString(), command.id);
    h.store.renewCommandClaims([command]);
    const lease = h.store.db
      .prepare('SELECT lease_expires_at AS expiry FROM job_commands WHERE id = ?')
      .get(command.id) as { expiry: string };
    expect(Date.parse(lease.expiry)).toBeGreaterThan(Date.now() + 100_000);
    expect(h.store.claimCommands()).toHaveLength(0);
    h.store.withCommandClaim(command, () => h.store.completeCommand(command.id));
    expect(h.store.claimCommands()[0]?.type).toBe('PAUSE_JOB');
  });

  it('rolls back state, events and outbox if command completion fails', async () => {
    h.store.enqueueCommand(jobId, 'START_JOB');
    vi.spyOn(h.store, 'completeCommand').mockImplementationOnce(() => {
      throw new Error('simulated interruption');
    });
    await processCommands(h.ctx);
    expect(h.store.getJob(jobId)?.state).toBe('QUEUED');
    expect(h.store.listEvents(jobId)).toHaveLength(0);
    expect(h.store.outboxStatus(jobId).pending).toBe(0);
    expect(h.store.listCommands(jobId)[0]?.state).toBe('REJECTED');
  });

  it('rolls back an approval with its item state if completion fails', async () => {
    h.writeSource('contract.txt', 'NDA contract');
    h.store.enqueueCommand(jobId, 'START_JOB');
    await runUntilIdle(h);
    const item = h.store.listItems(jobId)[0]!;
    const beforeRouting = h.store.getRouting(item.id);
    const beforeEvents = h.store.listEvents(jobId).length;
    approveItem(h, item, h.catalog.entries[0]!.key);
    vi.spyOn(h.store, 'completeCommand').mockImplementationOnce(() => {
      throw new Error('simulated interruption');
    });
    await processCommands(h.ctx);
    expect(h.store.getItem(item.id)?.state).toBe(item.state);
    expect(h.store.getRouting(item.id)).toEqual(beforeRouting);
    expect(h.store.listEvents(jobId)).toHaveLength(beforeEvents);
    expect(h.store.latestReviewCommand(jobId, item.id)?.state).toBe('REJECTED');
  });

  it('does not replay an interrupted report upload with an unknown Box outcome', async () => {
    h.store.enqueueCommand(jobId, 'GENERATE_REPORT');
    h.store.claimCommands();
    expireClaims();
    const upload = vi.spyOn(h.gateway, 'uploadDirect');
    expect(await processCommands(h.ctx)).toBe(0);
    expect(upload).not.toHaveBeenCalled();
    const operation = buildJobSnapshot(h.store, jobId)!.commands[0]!;
    expect(operation.state).toBe('REJECTED');
    expect(operation.rejectionReason).toContain('Boxへの保存結果を確認できません');
  });
});

describe('report outcomes', () => {
  it.each(['both', 'csv'] as const)(
    'rejects the command on %s upload failure without failing the migration',
    async (failed) => {
      h.store.setJobState(jobId, 'COMPLETED');
      const original = h.gateway.uploadDirect.bind(h.gateway);
      vi.spyOn(h.gateway, 'uploadDirect').mockImplementation(async (input) => {
        if (failed === 'both' || input.name.endsWith('.csv'))
          throw new Error('synthetic upload failure');
        return original(input);
      });
      h.store.enqueueCommand(jobId, 'GENERATE_REPORT');
      await processCommands(h.ctx);
      const operation = buildJobSnapshot(h.store, jobId)!.commands[0]!;
      expect(operation.state).toBe('REJECTED');
      expect(operation.rejectionReason).toContain('Box保存を確認できません');
      expect(h.store.getJob(jobId)?.state).toBe('COMPLETED');
      expect(
        readdirSync(h.config.reportsDir)
          .sort()
          .map((name) => name.split('.').at(-1)),
      ).toEqual(['csv', 'json']);
      expect(h.store.listEvents(jobId).map((e) => e.status)).toEqual(['FAILED']);
    },
  );

  it('marks the command successful only after both report files are saved', async () => {
    const upload = vi.spyOn(h.gateway, 'uploadDirect');
    h.store.enqueueCommand(jobId, 'GENERATE_REPORT');
    await processCommands(h.ctx);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(buildJobSnapshot(h.store, jobId)!.commands[0]?.state).toBe('DONE');
    expect(h.store.listEvents(jobId)[0]?.status).toBe('SUCCEEDED');
  });
});
