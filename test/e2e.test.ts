import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { destinationFolderId } from '@shuttle-lite/box';
import { stagingFileName } from '@shuttle-lite/core';
import { JsonlTelemetrySink, OutboxSender } from '@shuttle-lite/telemetry';
import { generateReport } from '../apps/worker/src/report';
import { approveItem, createHarness, runUntilIdle, type Harness } from './harness';

const CONTRACT = [
  '業務委託契約書',
  '契約番号: LEG-2026-0042',
  '発効日 2026-04-01',
  '甲および乙は本契約に基づき業務委託を行う。',
].join('\n');

const INVOICE = [
  '請求書',
  '請求番号: FIN-2026-0007',
  '発行日 2026-05-31',
  '消費税 10%',
  '支払期限 翌月末',
].join('\n');

describe('end to end migration with the fake Box gateway', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(() => {
    harness.cleanup();
  });

  it('carries a file from scan to final placement only after a human approval', async () => {
    const source = harness.writeSource('legal/msa.txt', CONTRACT);
    const profile = harness.createProfile();
    const job = harness.store.createJob({ profileId: profile.id, operatorLabel: 'tester' });
    harness.store.enqueueCommand(job.id, 'START_JOB');

    await runUntilIdle(harness);

    // Everything up to review happens without a human.
    const staged = harness.store.listItems(job.id);
    expect(staged).toHaveLength(1);
    const item = staged[0]!;
    expect(item.state).toBe('REVIEW_REQUIRED');
    expect(item.sourceSha1).toBe(source.sha1);
    expect(item.boxSha1).toBe(source.sha1);
    expect(item.boxSize).toBe(source.size);
    expect(item.transferVerifiedAt).not.toBeNull();
    expect(item.provenanceAppliedAt).not.toBeNull();
    expect(item.stagingName).toBe(stagingFileName(item.id, 'msa.txt'));

    // The staged copy carries provenance, and the AI only suggested.
    const metadata = await harness.gateway.getMetadata(item.boxFileId!);
    expect(metadata).toMatchObject({
      migrationJobId: job.id,
      migrationItemId: item.id,
      sourceRelativePath: 'legal/msa.txt',
      sourceSha1: source.sha1,
      migrationStatus: 'VERIFIED',
    });
    expect(metadata?.sourceRelativePath).not.toContain(harness.sourceRoot);

    const routing = harness.store.getRouting(item.id)!;
    expect(routing.state).toBe('SUGGESTED');
    expect(routing.suggestedDestinationKey).toBe('LEGAL_CONTRACTS');
    expect(routing.approvedDestinationKey).toBeNull();
    expect(item.finalFolderId).toBeNull();

    // Approve, then the worker moves inside Box and verifies the result.
    approveItem(harness, item, 'LEGAL_CONTRACTS');
    await runUntilIdle(harness);

    const completed = harness.store.getItem(item.id)!;
    expect(completed.state).toBe('COMPLETED');
    expect(completed.boxFileId).toBe(item.boxFileId);
    expect(completed.finalName).toBe('msa.txt');
    expect(completed.finalFolderId).toBe(
      destinationFolderId(harness.ctx.layout, 'LEGAL_CONTRACTS'),
    );

    const finalFile = await harness.gateway.getFile(completed.boxFileId!)!;
    expect(finalFile?.name).toBe('msa.txt');
    expect(finalFile?.sha1).toBe(source.sha1);
    const finalMetadata = await harness.gateway.getMetadata(completed.boxFileId!);
    expect(finalMetadata).toMatchObject({
      approvedDestinationKey: 'LEGAL_CONTRACTS',
      approvedBy: 'tester (local)',
      migrationStatus: 'PLACED',
      documentType: 'Contract',
    });
    expect(harness.store.getJob(job.id)?.state).toBe('COMPLETED');
  });

  it('uses the chunked path for a large file and keeps the digest intact', async () => {
    const big = Buffer.alloc(900 * 1024, 0x42);
    const source = harness.writeSource('it/runbooks/archive.md', big);
    const profile = harness.createProfile();
    const job = harness.store.createJob({ profileId: profile.id, operatorLabel: 'tester' });
    harness.store.enqueueCommand(job.id, 'START_JOB');

    await runUntilIdle(harness);

    const item = harness.store.listItems(job.id)[0]!;
    expect(item.uploadStrategy).toBe('CHUNKED');
    expect(item.state).toBe('REVIEW_REQUIRED');
    expect(item.boxSha1).toBe(source.sha1);
    expect(item.bytesTransferred).toBe(source.size);
    expect(harness.gateway.storedSize(item.boxFileId!)).toBe(source.size);
  });

  it('keeps two files with the same name apart and never overwrites', async () => {
    harness.writeSource('legal/nda.txt', `${CONTRACT}\nNDA A`);
    harness.writeSource('sales/nda.txt', `${CONTRACT}\nNDA B`);
    const profile = harness.createProfile();
    const job = harness.store.createJob({ profileId: profile.id, operatorLabel: 'tester' });
    harness.store.enqueueCommand(job.id, 'START_JOB');

    await runUntilIdle(harness);

    const items = harness.store.listItems(job.id);
    expect(items).toHaveLength(2);
    expect(new Set(items.map((entry) => entry.boxFileId)).size).toBe(2);
    expect(items.every((entry) => entry.state === 'REVIEW_REQUIRED')).toBe(true);

    // Both approved into the same destination. The RENAME policy places both
    // and lets the names differ, the way Box Shuttle does.
    for (const item of items) approveItem(harness, item, 'LEGAL_CONTRACTS');
    await runUntilIdle(harness);

    const after = harness.store.listItems(job.id);
    expect(after.every((entry) => entry.state === 'COMPLETED')).toBe(true);
    expect(new Set(after.map((entry) => entry.finalName))).toEqual(
      new Set(['nda.txt', 'nda (2).txt']),
    );
    // Two Box files, so neither content was replaced by the other.
    expect(new Set(after.map((entry) => entry.boxFileId)).size).toBe(2);
  });

  it('skips a name conflict when the job asks for it', async () => {
    harness.writeSource('legal/nda.txt', `${CONTRACT}\nNDA A`);
    harness.writeSource('sales/nda.txt', `${CONTRACT}\nNDA B`);
    const profile = harness.createProfile({ conflictPolicy: 'SKIP' });
    const job = harness.store.createJob({ profileId: profile.id, operatorLabel: 'tester' });
    harness.store.enqueueCommand(job.id, 'START_JOB');
    await runUntilIdle(harness);

    for (const item of harness.store.listItems(job.id)) {
      approveItem(harness, item, 'LEGAL_CONTRACTS');
    }
    await runUntilIdle(harness);

    const after = harness.store.listItems(job.id);
    expect(after.filter((entry) => entry.state === 'COMPLETED')).toHaveLength(1);
    const skipped = after.filter((entry) => entry.state === 'SKIPPED');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.lastErrorCategory).toBe('MOVE_CONFLICT');
    expect(skipped[0]?.finalFolderId).toBeNull();
  });

  it('never renames behind an operator who typed the name', async () => {
    harness.writeSource('legal/nda.txt', `${CONTRACT}\nNDA A`);
    harness.writeSource('sales/nda.txt', `${CONTRACT}\nNDA B`);
    const profile = harness.createProfile();
    const job = harness.store.createJob({ profileId: profile.id, operatorLabel: 'tester' });
    harness.store.enqueueCommand(job.id, 'START_JOB');
    await runUntilIdle(harness);

    const [first, second] = harness.store.listItems(job.id);
    approveItem(harness, first!, 'LEGAL_CONTRACTS');
    await runUntilIdle(harness);

    // The operator picked a name that is already taken. Silently changing it
    // would replace their decision, so this one stops for another look.
    approveItem(harness, second!, 'LEGAL_CONTRACTS', 'tester (local)', 'nda.txt');
    await runUntilIdle(harness);
    const blocked = harness.store.getItem(second!.id);
    expect(blocked?.state).toBe('NEEDS_REVIEW');
    expect(blocked?.lastErrorCategory).toBe('MOVE_CONFLICT');

    approveItem(harness, second!, 'LEGAL_CONTRACTS', 'tester (local)', 'nda-sales.txt');
    await runUntilIdle(harness);
    const resolved = harness.store.getItem(second!.id);
    expect(resolved?.state).toBe('COMPLETED');
    expect(resolved?.finalName).toBe('nda-sales.txt');
    expect(resolved?.boxFileId).toBe(second?.boxFileId);
  });

  it('lets an operator finish a file the AI could not read', async () => {
    harness.writeSource('binary/dump.zip', Buffer.from('PK\u0003\u0004 synthetic'));
    const profile = harness.createProfile();
    const job = harness.store.createJob({ profileId: profile.id, operatorLabel: 'tester' });
    harness.store.enqueueCommand(job.id, 'START_JOB');

    await runUntilIdle(harness);

    const item = harness.store.listItems(job.id)[0]!;
    expect(item.state).toBe('NEEDS_REVIEW');
    expect(item.lastErrorCategory).toBe('AI_UNSUPPORTED');
    // The file is staged and verified: only the classification is missing.
    expect(item.boxFileId).not.toBeNull();
    expect(item.transferVerifiedAt).not.toBeNull();

    approveItem(harness, item, 'IT_RUNBOOKS');
    await runUntilIdle(harness);

    const completed = harness.store.getItem(item.id)!;
    expect(completed.state).toBe('COMPLETED');
    expect(harness.store.getRouting(item.id)?.humanOverride).toBe(false);
  });

  it('records a human override when the operator picks another destination', async () => {
    harness.writeSource('finance/invoice.txt', INVOICE);
    const profile = harness.createProfile();
    const job = harness.store.createJob({ profileId: profile.id, operatorLabel: 'tester' });
    harness.store.enqueueCommand(job.id, 'START_JOB');
    await runUntilIdle(harness);

    const item = harness.store.listItems(job.id)[0]!;
    expect(harness.store.getRouting(item.id)?.suggestedDestinationKey).toBe('FINANCE_INVOICES');

    approveItem(harness, item, 'LEGAL_CONTRACTS');
    await runUntilIdle(harness);

    const routing = harness.store.getRouting(item.id)!;
    expect(routing.humanOverride).toBe(true);
    expect(routing.approvedDestinationKey).toBe('LEGAL_CONTRACTS');
    expect(harness.store.getItem(item.id)?.state).toBe('COMPLETED');
  });

  it('asks for another decision when the file changed after approval', async () => {
    harness.writeSource('legal/msa.txt', CONTRACT);
    const profile = harness.createProfile();
    const job = harness.store.createJob({ profileId: profile.id, operatorLabel: 'tester' });
    harness.store.enqueueCommand(job.id, 'START_JOB');
    await runUntilIdle(harness);

    const item = harness.store.listItems(job.id)[0]!;
    approveItem(harness, item, 'LEGAL_CONTRACTS');
    await processCommandsOnly(harness);
    expect(harness.store.getItem(item.id)?.state).toBe('APPROVED');

    // Stand in for a new file version appearing in Box between the approval
    // and the move: the recorded snapshot no longer matches the live file.
    harness.store.recordApproval({
      itemId: item.id,
      approvedDestinationKey: 'LEGAL_CONTRACTS',
      approvedMetadata: {},
      approvedBoxFileId: item.boxFileId!,
      approvedBoxVersionId: 'ver-stale',
      approvedSha1: item.boxSha1!,
      operatorLabel: 'tester (local)',
      humanOverride: false,
    });

    await runUntilIdle(harness);

    const after = harness.store.getItem(item.id)!;
    expect(after.state).toBe('REVIEW_REQUIRED');
    expect(after.lastErrorCategory).toBe('APPROVAL_STALE');
    expect(harness.store.getRouting(item.id)?.state).toBe('STALE');
    expect(after.finalFolderId).toBeNull();
  });

  it('stops starting new work when the operator pauses the job', async () => {
    harness.writeSource('legal/a.txt', CONTRACT);
    harness.writeSource('legal/b.txt', `${CONTRACT}\nB`);
    const profile = harness.createProfile();
    const job = harness.store.createJob({ profileId: profile.id, operatorLabel: 'tester' });
    harness.store.enqueueCommand(job.id, 'START_JOB');
    harness.store.enqueueCommand(job.id, 'PAUSE_JOB');

    await runUntilIdle(harness);

    expect(harness.store.getJob(job.id)?.state).toBe('PAUSED');
    const items = harness.store.listItems(job.id);
    expect(items.every((item) => item.state !== 'COMPLETED')).toBe(true);

    harness.store.enqueueCommand(job.id, 'RESUME_JOB');
    await runUntilIdle(harness);
    expect(harness.store.listItems(job.id).every((item) => item.state === 'REVIEW_REQUIRED')).toBe(
      true,
    );
  });

  it('produces a report and delivers allowlisted telemetry', async () => {
    harness.writeSource('legal/msa.txt', CONTRACT);
    harness.writeSource('finance/invoice.txt', INVOICE);
    const profile = harness.createProfile();
    const job = harness.store.createJob({ profileId: profile.id, operatorLabel: 'tester' });
    harness.store.enqueueCommand(job.id, 'START_JOB');
    await runUntilIdle(harness);
    for (const item of harness.store.listItems(job.id)) {
      approveItem(harness, item, harness.store.getRouting(item.id)!.suggestedDestinationKey!);
    }
    await runUntilIdle(harness);

    const report = await generateReport(harness.ctx, job.id);
    expect(report.rows).toHaveLength(2);
    expect(report.rows.every((row) => row.finalState === 'COMPLETED')).toBe(true);
    expect(report.rows.every((row) => row.sha1Verified && row.sizeVerified)).toBe(true);
    expect(report.rows.every((row) => row.boxLink?.startsWith('https://app.box.com/file/'))).toBe(
      true,
    );
    expect(report.boxCsvFileId).not.toBeNull();
    const csv = readFileSync(report.csvPath, 'utf8');
    expect(csv.split('\n')[0]).toContain('migrationItemId');

    const sink = new JsonlTelemetrySink(harness.config.telemetry.jsonlPath);
    const sender = new OutboxSender({ store: harness.store, sink, batchSize: 100 });
    let delivered = 0;
    for (let i = 0; i < 10; i += 1) {
      const result = await sender.runOnce();
      delivered += result.delivered;
      if (result.claimed === 0) break;
    }
    expect(delivered).toBeGreaterThan(0);
    const lines = readFileSync(sink.path, 'utf8').trim().split('\n');
    expect(lines.length).toBe(delivered);
    const payload = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(Object.keys(payload)).not.toContain('message');
    expect(readFileSync(sink.path, 'utf8')).not.toContain('msa.txt');
  });
});

/** Applies queued commands without running the pipeline. */
async function processCommandsOnly(harness: Harness): Promise<void> {
  const { processCommands } = await import('../apps/worker/src/commands');
  await processCommands(harness.ctx);
}
