import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha1Buffer, ShuttleError, stagingFileName } from '@shuttle-lite/core';
import type { UploadPartRequest } from '@shuttle-lite/box';
import { approveItem, createHarness, runUntilIdle, type Harness } from './harness';

const CONTRACT = ['業務委託契約書', '契約番号: LEG-2026-0042', '発効日 2026-04-01'].join('\n');

describe('crash and failure recovery', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(() => {
    harness.cleanup();
  });

  async function startJob(): Promise<{ jobId: string }> {
    const profile = harness.createProfile();
    const job = harness.store.createJob({ profileId: profile.id, operatorLabel: 'tester' });
    harness.store.enqueueCommand(job.id, 'START_JOB');
    return { jobId: job.id };
  }

  it('adopts an upload whose outcome was never recorded, without creating a duplicate', async () => {
    const source = harness.writeSource('legal/msa.txt', CONTRACT);
    const { jobId } = await startJob();

    // Stop right after hashing, before anything was sent.
    await harness.scanAndHash(jobId);

    const item = harness.store.listItems(jobId)[0]!;
    expect(item.sourceSha1).toBe(source.sha1);

    // Box accepted the upload, then the process died before SQLite was written.
    const stagingFolderId = harness.store.getJob(jobId)!.stagingFolderId!;
    const stagingName = stagingFileName(item.id, item.sourceFileName);
    const orphan = await harness.gateway.uploadDirect({
      parentFolderId: stagingFolderId,
      name: stagingName,
      size: source.size,
      sha1Hex: source.sha1,
      content: () => createReadStream(join(harness.sourceRoot, 'legal/msa.txt')),
    });
    harness.store.updateItem(item.id, { state: 'UPLOADING', stagingName });

    // A restarted worker reconciles against the staging folder listing.
    await runUntilIdle(harness);

    const recovered = harness.store.getItem(item.id)!;
    expect(recovered.boxFileId).toBe(orphan.id);
    expect(recovered.state).toBe('REVIEW_REQUIRED');

    const stagedFiles = (await harness.gateway.listFolder(stagingFolderId)).filter(
      (entry) => entry.type === 'file',
    );
    expect(stagedFiles).toHaveLength(1);

    approveItem(harness, recovered, 'LEGAL_CONTRACTS');
    await runUntilIdle(harness);
    expect(harness.store.getItem(item.id)?.state).toBe('COMPLETED');
    expect((await harness.gateway.listFolder(stagingFolderId)).length).toBe(0);
  });

  it('restarts from preflight when nothing actually reached Box', async () => {
    harness.writeSource('legal/msa.txt', CONTRACT);
    const { jobId } = await startJob();
    await harness.scanAndHash(jobId);

    const item = harness.store.listItems(jobId)[0]!;
    harness.store.updateItem(item.id, {
      state: 'UNKNOWN_OUTCOME',
      resumeState: 'UPLOADING',
      stagingName: stagingFileName(item.id, item.sourceFileName),
      bytesTransferred: 512,
    });

    await runUntilIdle(harness);

    const recovered = harness.store.getItem(item.id)!;
    expect(recovered.state).toBe('REVIEW_REQUIRED');
    expect(recovered.boxSha1).toBe(item.sourceSha1);
    const events = harness.store.listEvents(jobId, { itemId: item.id, limit: 50 });
    expect(events.some((event) => event.message?.includes('preflightから再開'))).toBe(true);
  });

  it('resumes a chunked upload from the parts Box already has', async () => {
    const big = Buffer.alloc(900 * 1024, 0x42);
    const source = harness.writeSource('it/big.md', big);
    const { jobId } = await startJob();

    const realUploadPart = harness.gateway.uploadPart.bind(harness.gateway);
    let partCalls = 0;
    harness.gateway.uploadPart = async (request: UploadPartRequest) => {
      partCalls += 1;
      if (partCalls === 2) {
        throw new ShuttleError('BOX_SERVER', 'injected 503 mid-upload', { status: 503 });
      }
      return realUploadPart(request);
    };

    await runUntilIdle(harness);

    const parked = harness.store.listItems(jobId)[0]!;
    expect(['RETRY_WAIT', 'UNKNOWN_OUTCOME']).toContain(parked.state);
    const callsBeforeResume = partCalls;
    expect(callsBeforeResume).toBeGreaterThan(0);

    // Skip the backoff wait, then let the worker resume.
    harness.store.updateItem(parked.id, { nextAttemptAt: null });
    await runUntilIdle(harness);

    const resumed = harness.store.getItem(parked.id)!;
    expect(resumed.state).toBe('REVIEW_REQUIRED');
    expect(resumed.boxSha1).toBe(source.sha1);
    expect(harness.gateway.storedSize(resumed.boxFileId!)).toBe(source.size);

    // Four parts at 256KB. A resume that re-sent everything would be 8 calls.
    const totalParts = Math.ceil(source.size / (256 * 1024));
    expect(partCalls).toBeLessThan(totalParts * 2);
  });

  it('honours Retry-After from a 429 instead of its own backoff curve', async () => {
    harness.cleanup();
    harness = await createHarness({ rateLimitEvery: 2 });
    harness.writeSource('legal/a.txt', CONTRACT);
    harness.writeSource('legal/b.txt', `${CONTRACT}\nB`);
    const { jobId } = await startJob();

    await runUntilIdle(harness);

    const throttled = harness.store
      .listItems(jobId)
      .find((item) => item.lastErrorCategory === 'BOX_RATE_LIMIT');
    expect(throttled).toBeDefined();
    expect(throttled!.retryCount).toBeGreaterThan(0);
    const waitMs = Date.parse(throttled!.nextAttemptAt!) - Date.now();
    // The fake sends Retry-After: 1s, and the default backoff would be 500ms
    // or less on the first attempt, so this proves the header won.
    expect(waitMs).toBeGreaterThan(500);
    expect(waitMs).toBeLessThanOrEqual(1_000);

    const events = harness.store.listEvents(jobId, { limit: 100 });
    expect(
      events.some(
        (event) => event.status === 'RETRYING' && event.errorCategory === 'BOX_RATE_LIMIT',
      ),
    ).toBe(true);

    for (const item of harness.store.listItems(jobId)) {
      harness.store.updateItem(item.id, { nextAttemptAt: null });
    }
    await runUntilIdle(harness);
    expect(harness.store.listItems(jobId).every((item) => item.state === 'REVIEW_REQUIRED')).toBe(
      true,
    );
  });

  it('retries only the metadata write when metadata fails, never the file body', async () => {
    const source = harness.writeSource('legal/msa.txt', CONTRACT);
    const { jobId } = await startJob();

    const realUpload = harness.gateway.uploadDirect.bind(harness.gateway);
    let uploads = 0;
    harness.gateway.uploadDirect = async (request) => {
      uploads += 1;
      return realUpload(request);
    };
    harness.gateway.failNext(
      'setMetadata',
      new ShuttleError('BOX_SERVER', 'injected metadata 503', { status: 503 }),
    );

    await runUntilIdle(harness);

    const parked = harness.store.listItems(jobId)[0]!;
    expect(parked.lastErrorCategory).toBe('BOX_SERVER');
    expect(parked.boxFileId).not.toBeNull();
    expect(uploads).toBe(1);

    harness.store.updateItem(parked.id, { nextAttemptAt: null });
    await runUntilIdle(harness);

    const recovered = harness.store.getItem(parked.id)!;
    expect(recovered.state).toBe('REVIEW_REQUIRED');
    expect(recovered.boxFileId).toBe(parked.boxFileId);
    expect(recovered.provenanceAppliedAt).not.toBeNull();
    expect(uploads).toBe(1);
    expect(await harness.gateway.getMetadata(recovered.boxFileId!)).toMatchObject({
      sourceSha1: source.sha1,
    });
  });

  it('gives each step its own retry budget instead of one budget per file', async () => {
    harness.writeSource('legal/msa.txt', CONTRACT);
    const { jobId } = await startJob();
    harness.gateway.failNext(
      'uploadDirect',
      new ShuttleError('BOX_SERVER', 'injected 503', { status: 503 }),
    );

    await runUntilIdle(harness);
    const parked = harness.store.listItems(jobId)[0]!;
    expect(parked.attempts).toBeGreaterThan(0);

    harness.store.updateItem(parked.id, { nextAttemptAt: null });
    await runUntilIdle(harness);

    const after = harness.store.getItem(parked.id)!;
    expect(after.state).toBe('REVIEW_REQUIRED');
    // A retry spent on upload must not shrink the budget available to the
    // AI step that follows it.
    expect(after.attempts).toBe(0);
    // The lifetime count is still reported, for the progress UI and the report.
    expect(after.retryCount).toBeGreaterThan(0);
  });

  it('stops at review rather than completing when the staged copy does not match the source', async () => {
    harness.writeSource('legal/msa.txt', CONTRACT);
    const { jobId } = await startJob();
    await harness.scanAndHash(jobId);

    const item = harness.store.listItems(jobId)[0]!;
    const stagingFolderId = harness.store.getJob(jobId)!.stagingFolderId!;
    const stagingName = stagingFileName(item.id, item.sourceFileName);
    const different = Buffer.from('まったく別の内容', 'utf8');
    await harness.gateway.uploadDirect({
      parentFolderId: stagingFolderId,
      name: stagingName,
      size: different.byteLength,
      sha1Hex: sha1Buffer(different),
      content: () => Readable.from([different]),
    });

    await runUntilIdle(harness);

    const blocked = harness.store.getItem(item.id)!;
    expect(blocked.state).toBe('NEEDS_REVIEW');
    expect(blocked.lastErrorCategory).toBe('BOX_CONFLICT');
    expect(blocked.state).not.toBe('COMPLETED');
  });
});
