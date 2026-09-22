import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MigrationJob } from '@shuttle-lite/core';
import { POST } from '../apps/web/src/app/api/jobs/route';
import { getCatalog, getConfig, getStore } from '../apps/web/src/lib/runtime';
import { approveItem, createHarness, runUntilIdle, type Harness } from './harness';

vi.mock('../apps/web/src/lib/runtime', () => ({
  getCatalog: vi.fn(),
  getConfig: vi.fn(),
  getStore: vi.fn(),
}));

function request(body: unknown): Request {
  return new Request('http://localhost/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('creating a migration without registering a source first', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
    vi.mocked(getStore).mockReturnValue(harness.store);
    vi.mocked(getConfig).mockReturnValue(harness.config);
    vi.mocked(getCatalog).mockReturnValue(harness.catalog);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    harness.cleanup();
  });

  it('creates and starts a named migration, then waits for approval before placement', async () => {
    const source = harness.writeSource('契約書.txt', '業務委託契約書 契約番号 LEG-2026-0042');
    expect(harness.store.listProfiles()).toHaveLength(0);
    const response = await POST(
      request({ name: '  営業部の文書整理  ', sourceRootPath: harness.sourceRoot }),
    );
    expect(response.status).toBe(201);
    const { job } = (await response.json()) as { job: MigrationJob };
    expect(job.name).toBe('営業部の文書整理');
    expect(job.operatorLabel).toBe('ローカル操作者');
    expect(job.state).toBe('QUEUED');
    expect(harness.store.getProfile(job.profileId)).toMatchObject({
      sourceRootPath: harness.sourceRoot,
      aiRoutingEnabled: true,
      conflictPolicy: 'RENAME',
      snowflakeLoggingEnabled: true,
      fileConcurrency: harness.config.limits.fileConcurrency,
      chunkConcurrency: harness.config.limits.chunkConcurrency,
    });
    expect(harness.store.listCommands(job.id)).toEqual([
      expect.objectContaining({ type: 'START_JOB', state: 'PENDING' }),
    ]);
    expect(harness.store.listItems(job.id)).toHaveLength(0);

    await runUntilIdle(harness);
    const item = harness.store.listItems(job.id)[0]!;
    expect(item.state).toBe('REVIEW_REQUIRED');
    expect(item.boxSha1).toBe(source.sha1);
    expect(item.finalFolderId).toBeNull();
    approveItem(harness, item, 'LEGAL_CONTRACTS');
    await runUntilIdle(harness);
    expect(harness.store.getItem(item.id)).toMatchObject({
      state: 'COMPLETED',
      boxFileId: item.boxFileId,
    });
    expect(harness.store.getJob(job.id)?.name).toBe('営業部の文書整理');
  });

  it('allows repeated names while retaining the separate sources and options of each migration', async () => {
    const secondSource = join(harness.dataDir, '別の部署 資料');
    mkdirSync(secondSource);
    const firstResponse = await POST(
      request({ name: '月次移行', sourceRootPath: harness.sourceRoot }),
    );
    const first = ((await firstResponse.json()) as { job: MigrationJob }).job;
    const secondResponse = await POST(
      request({
        name: '月次移行',
        sourceRootPath: secondSource,
        aiRoutingEnabled: false,
        conflictPolicy: 'SKIP',
        operatorLabel: '担当者',
      }),
    );
    expect(secondResponse.status).toBe(201);
    const second = ((await secondResponse.json()) as { job: MigrationJob }).job;
    expect(second.name).toBe(first.name);
    expect(second.profileId).not.toBe(first.profileId);
    expect(second.operatorLabel).toBe('担当者');
    expect(harness.store.getProfile(first.profileId)).toMatchObject({
      sourceRootPath: harness.sourceRoot,
      aiRoutingEnabled: true,
      conflictPolicy: 'RENAME',
    });
    expect(harness.store.getProfile(second.profileId)).toMatchObject({
      sourceRootPath: secondSource,
      aiRoutingEnabled: false,
      conflictPolicy: 'SKIP',
    });
  });

  it.each([
    { name: '' },
    { name: 'x'.repeat(101) },
    { sourceRootPath: 'relative/path' },
    { sourceRootPath: '~/Documents' },
    { sourceRootPath: '/path-with-\0-null' },
    { aiRoutingEnabled: 'false' },
    { conflictPolicy: 'OVERWRITE' },
    { conflictPolicy: ['SKIP'] },
    { autoStart: 'false' },
  ])('rejects invalid input without leaving any job or source behind: %j', async (input) => {
    const response = await POST(
      request({ name: 'テスト', sourceRootPath: harness.sourceRoot, ...input }),
    );
    expect(response.status).toBe(400);
    expect(harness.store.listProfiles()).toHaveLength(0);
    expect(harness.store.listJobs()).toHaveLength(0);
  });

  it('rejects a missing directory or a file path before creating a job', async () => {
    harness.writeSource('file.txt', 'test');
    for (const path of [
      join(harness.sourceRoot, 'missing'),
      join(harness.sourceRoot, 'file.txt'),
    ]) {
      const response = await POST(request({ name: 'テスト', sourceRootPath: path }));
      expect(response.status).toBe(400);
    }
    expect(harness.store.listProfiles()).toHaveLength(0);
    expect(harness.store.listJobs()).toHaveLength(0);
  });

  it.each(['null', '[]', '{'])('rejects a malformed request: %s', async (body) => {
    const response = await POST(new Request('http://localhost/api/jobs', { method: 'POST', body }));
    expect(response.status).toBe(400);
    expect(harness.store.listJobs()).toHaveLength(0);
  });

  it('does not override the shared AI-disabled setting', async () => {
    vi.mocked(getConfig).mockReturnValue({
      ...harness.config,
      ai: { ...harness.config.ai, enabled: false },
    });
    const response = await POST(
      request({ name: 'テスト', sourceRootPath: harness.sourceRoot, aiRoutingEnabled: true }),
    );
    expect(response.status).toBe(201);
    const { job } = (await response.json()) as { job: MigrationJob };
    expect(harness.store.getProfile(job.profileId)?.aiRoutingEnabled).toBe(false);
  });

  it('rolls back the source and job if enqueueing the start command fails', async () => {
    vi.spyOn(harness.store, 'enqueueCommand').mockImplementation(() => {
      throw new Error('enqueue failed');
    });
    await expect(
      POST(request({ name: 'テスト', sourceRootPath: harness.sourceRoot })),
    ).rejects.toThrow('enqueue failed');
    expect(harness.store.listJobs()).toHaveLength(0);
    expect(harness.store.listProfiles()).toHaveLength(0);
  });

  it('keeps the existing profile API and deferred start working', async () => {
    const profile = harness.createProfile({ name: '既存の設定', aiRoutingEnabled: false });
    const response = await POST(
      request({ profileId: profile.id, operatorLabel: '既存の操作者', autoStart: false }),
    );
    expect(response.status).toBe(201);
    const { job } = (await response.json()) as { job: MigrationJob };
    expect(job.name).toBe('既存の設定');
    expect(harness.store.listProfiles()).toHaveLength(1);
    expect(harness.store.listCommands(job.id)).toHaveLength(0);
    await runUntilIdle(harness);
    expect(harness.store.getJob(job.id)?.state).toBe('QUEUED');
    expect(harness.store.getProfile(profile.id)).toEqual(profile);
  });
});
