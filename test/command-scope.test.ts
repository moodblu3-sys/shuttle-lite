import { expect, it } from 'vitest';
import { processCommands } from '../apps/worker/src/commands';
import { createHarness, runUntilIdle } from './harness';

it.each(['APPROVE_ITEM', 'SKIP_ITEM', 'SEND_TO_REVIEW', 'RETRY_ITEM'] as const)(
  'rejects %s when the document belongs to another job',
  async (type) => {
    const harness = await createHarness();
    try {
      harness.writeSource(
        '契約書.txt',
        '業務委託契約書 契約番号 LEG-2026-0042 甲乙は契約を締結する。',
      );
      const profile = harness.createProfile();
      const owner = harness.store.createJob({ profileId: profile.id, operatorLabel: 'owner' });
      harness.store.enqueueCommand(owner.id, 'START_JOB');
      await runUntilIdle(harness);
      const other = harness.store.createJob({ profileId: profile.id, operatorLabel: 'other' });
      const source = harness.store.listItems(owner.id)[0]!;
      const beforeRouting = harness.store.getRouting(source.id);
      const command = harness.store.enqueueCommand(other.id, type, {
        itemId: source.id,
        destinationKey: 'LEGAL_CONTRACTS',
        operatorLabel: 'other',
        observedBoxFileId: source.boxFileId,
        observedSha1: source.boxSha1,
        observedVersionId: source.boxFileVersionId,
        metadata: {},
      });
      await processCommands(harness.ctx);
      const result = harness.store.listCommands(other.id).find((entry) => entry.id === command.id)!;
      expect(result.state).toBe('REJECTED');
      expect(result.rejectionReason).toContain('job');
      expect(harness.store.getItem(source.id)).toEqual(source);
      expect(harness.store.getRouting(source.id)).toEqual(beforeRouting);
    } finally {
      harness.cleanup();
    }
  },
);
