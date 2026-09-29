import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MigrationJob, TemplateMapping } from '@shuttle-lite/core';
import { templateId } from '@shuttle-lite/core';
import { demoBusinessTemplates } from '../packages/box/src/fake/business-templates';
import { GET as review } from '../apps/web/src/app/api/jobs/[jobId]/review/route';
import { checkSource } from '../apps/web/src/lib/source-check';
import { POST } from '../apps/web/src/app/api/jobs/route';
import { getBoxGateway, getCatalog, getConfig, getStore } from '../apps/web/src/lib/runtime';
import { approveItem, createHarness, runUntilIdle, type Harness } from './harness';

vi.mock('../apps/web/src/lib/runtime', () => ({
  getCatalog: vi.fn(),
  getBoxGateway: vi.fn(),
  getConfig: vi.fn(),
  getStore: vi.fn(),
}));

let destinationFolderId: string;

function request(body: unknown): Request {
  return new Request('http://localhost/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      body && typeof body === 'object' ? { destinationFolderId, ...body } : body,
    ),
  });
}

describe('creating a migration without registering a source first', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
    destinationFolderId = (await harness.gateway.ensureFolder('0', '営業部')).id;
    vi.mocked(getBoxGateway).mockResolvedValue(harness.gateway);
    vi.mocked(getStore).mockReturnValue(harness.store);
    vi.mocked(getConfig).mockReturnValue(harness.config);
    vi.mocked(getCatalog).mockReturnValue(harness.catalog);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    harness.cleanup();
  });

  it('creates a job after a successful source check without changing the inventory', async () => {
    harness.writeSource('確認.txt', '内容');
    const checked = await checkSource(harness.sourceRoot);
    const response = await POST(
      request({
        name: '確認済み',
        sourceRootPath: harness.sourceRoot,
        sourceCheck: checked.signature,
      }),
    );
    expect(response.status).toBe(201);
    expect(harness.store.listJobs()).toHaveLength(1);
  });

  it('rejects a changed source before reading Box or creating a job', async () => {
    harness.writeSource('確認.txt', '内容');
    const checked = await checkSource(harness.sourceRoot);
    harness.writeSource('追加.txt', '確認後の追加');
    const box = vi.spyOn(harness.gateway, 'getFolder');
    const response = await POST(
      request({
        name: '変更あり',
        sourceRootPath: harness.sourceRoot,
        sourceCheck: checked.signature,
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ sourceChanged: true });
    expect(box).not.toHaveBeenCalled();
    expect(harness.store.listProfiles()).toHaveLength(0);
    expect(harness.store.listJobs()).toHaveLength(0);
  });

  it('persists test mode only when explicitly selected', async () => {
    const response = await POST(
      request({ name: 'demo', sourceRootPath: harness.sourceRoot, testMode: true }),
    );
    expect(response.status).toBe(201);
    expect(((await response.json()) as { job: MigrationJob }).job).toMatchObject({
      testMode: true,
      cleanupState: 'NONE',
    });
    const bad = await POST(
      request({ name: 'demo', sourceRootPath: harness.sourceRoot, testMode: 'true' }),
    );
    expect(bad.status).toBe(400);
    expect(harness.store.listJobs()).toHaveLength(1);
  });

  it('creates an independent preserve-hierarchy job without collecting classification candidates', async () => {
    const nested = await harness.gateway.ensureFolder(destinationFolderId, '多数の既存フォルダー');
    const list = vi.spyOn(harness.gateway, 'listFolder');
    const response = await POST(
      request({
        name: 'そのまま',
        sourceRootPath: harness.sourceRoot,
        migrationMode: 'AS_IS',
        aiRoutingEnabled: true,
      }),
    );
    expect(response.status).toBe(201);
    const { job } = (await response.json()) as { job: MigrationJob };
    expect(job.migrationMode).toBe('AS_IS');
    expect(harness.store.getProfile(job.profileId)?.aiRoutingEnabled).toBe(false);
    expect(harness.store.getJobMetadata(job.id)).toEqual([]);
    expect(harness.store.getJobDestinations(job.id)?.entries).toHaveLength(1);
    expect(list).not.toHaveBeenCalledWith(nested.id);
  });

  it('keeps AI-disabled existing mode waiting for manual approval', async () => {
    harness.writeSource('メモ.txt', '打合せ');
    const response = await POST(
      request({ name: '手動', sourceRootPath: harness.sourceRoot, aiRoutingEnabled: false }),
    );
    const { job } = (await response.json()) as { job: MigrationJob };
    expect(job.migrationMode).toBe('AI_ORGANIZE');
    await runUntilIdle(harness);
    expect(harness.store.listItems(job.id)[0]?.state).toBe('REVIEW_REQUIRED');
    expect(harness.store.listMigrationFolders(job.id)).toEqual([]);
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
    approveItem(harness, item, harness.store.getJobDestinations(job.id)!.entries[0]!.key);
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
    { sourceCheck: 'invalid' },
    { sourceCheck: null },
    { destinationFolderId: undefined },
    { destinationFolderId: '0' },
    { destinationFolderId: '../outside' },
    { destinationFolderId: 'missing-folder' },
    { name: 'x'.repeat(101) },
    { sourceRootPath: 'relative/path' },
    { sourceRootPath: '~/Documents' },
    { sourceRootPath: '/path-with-\0-null' },
    { aiRoutingEnabled: 'false' },
    { conflictPolicy: 'OVERWRITE' },
    { conflictPolicy: ['SKIP'] },
    { autoStart: 'false' },
    { migrationMode: 'UNKNOWN_MODE' },
    { migrationMode: null },
    { migrationMode: 'AS_IS', sourceRootPath: '/' },
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

  it('freezes selected templates per job for AI, review and approval, regardless of global settings', async () => {
    const [contract, invoice] = demoBusinessTemplates;
    for (const template of demoBusinessTemplates)
      await harness.gateway.createMetadataTemplate(template);
    harness.store.saveMetadataSettings([{ template: invoice! }], 0);
    harness.writeSource('契約書.txt', '業務委託契約書\n契約先：A社');
    const classify = vi.spyOn(harness.gateway, 'extractStructured').mockResolvedValue({
      provider: 'test',
      confidence: null,
      references: [],
      fields: {
        documentType: '契約書',
        metadataTemplateId: templateId(contract!),
        suggestedDestinationKey: 'NEEDS_REVIEW',
      },
    });
    const response = await POST(
      request({
        name: '契約書だけ',
        sourceRootPath: harness.sourceRoot,
        metadataTemplates: [
          { scope: contract!.scope, templateKey: contract!.templateKey, fields: [] },
        ],
      }),
    );
    expect(response.status).toBe(201);
    const { job } = (await response.json()) as { job: MigrationJob };
    expect(harness.store.getJobMetadata(job.id)).toEqual([{ template: contract }]);
    const second = await POST(
      request({
        name: '請求書だけ',
        sourceRootPath: harness.sourceRoot,
        autoStart: false,
        metadataTemplates: [{ scope: invoice!.scope, templateKey: invoice!.templateKey }],
      }),
    );
    const other = ((await second.json()) as { job: MigrationJob }).job;
    harness.store.saveMetadataSettings([], 1);
    expect(harness.store.getAvailableJobMetadata(other.id)).toEqual([{ template: invoice }]);
    await runUntilIdle(harness);
    expect(classify.mock.calls[0]![0].metadataTemplates).toEqual([contract]);
    const item = harness.store.listItems(job.id)[0]!;
    expect(harness.store.getBusinessMetadata(item.id)).toMatchObject({
      templateId: templateId(contract!),
      extractionStatus: 'EXTRACTED',
    });
    const view = await review(new Request(`http://localhost/api/jobs/${job.id}/review`), {
      params: Promise.resolve({ jobId: job.id }),
    });
    expect(
      ((await view.json()) as { metadataTemplates: TemplateMapping[] }).metadataTemplates,
    ).toEqual([{ template: contract }]);
    harness.store.enqueueCommand(job.id, 'SELECT_METADATA_TEMPLATE', {
      itemId: item.id,
      templateId: templateId(invoice!),
      extract: false,
      revision: harness.store.getBusinessMetadata(item.id).revision,
      observedBoxFileId: item.boxFileId,
      observedSha1: item.boxSha1,
    });
    await runUntilIdle(harness);
    expect(
      harness.store
        .listCommands(job.id)
        .find((command) => command.type === 'SELECT_METADATA_TEMPLATE')?.state,
    ).toBe('REJECTED');
    approveItem(harness, item, harness.store.getJobDestinations(job.id)!.entries[0]!.key);
    await runUntilIdle(harness);
    expect(harness.store.getItem(item.id)?.state).toBe('COMPLETED');
    expect(await harness.gateway.getMetadata(item.boxFileId!, contract!)).toMatchObject({
      counterparty: 'A社',
    });
    expect(await harness.gateway.getMetadata(item.boxFileId!, invoice!)).toBeNull();
  });

  it.each([undefined, []])(
    'does not inherit global templates when a new job selects %j',
    async (metadataTemplates) => {
      harness.store.saveMetadataSettings(
        demoBusinessTemplates.map((template) => ({ template })),
        0,
      );
      harness.writeSource('契約書.txt', '契約書');
      const classify = vi.spyOn(harness.gateway, 'extractStructured');
      const extract = vi.spyOn(harness.gateway, 'extractTemplate');
      const response = await POST(
        request({ name: 'メタデータなし', sourceRootPath: harness.sourceRoot, metadataTemplates }),
      );
      const { job } = (await response.json()) as { job: MigrationJob };
      expect(harness.store.getAvailableJobMetadata(job.id)).toEqual([]);
      await runUntilIdle(harness);
      expect(classify.mock.calls[0]![0].metadataTemplates).toEqual([]);
      expect(extract).not.toHaveBeenCalled();
      expect(harness.store.listItems(job.id)[0]?.state).toBe('REVIEW_REQUIRED');
    },
  );

  it.each([
    null,
    {},
    ['invalid'],
    [null],
    [{ scope: 'enterprise', templateKey: 'missing' }],
    [{ scope: ['enterprise'], templateKey: 'contract' }],
    [{ scope: 'enterprise', templateKey: '../contract' }],
    Array.from({ length: 101 }, () => ({ scope: 'enterprise', templateKey: 'contract' })),
    [demoBusinessTemplates[0], demoBusinessTemplates[0]],
  ])('rejects invalid or unavailable templates atomically: %j', async (metadataTemplates) => {
    const response = await POST(
      request({ name: 'テスト', sourceRootPath: harness.sourceRoot, metadataTemplates }),
    );
    expect(response.status).toBe(400);
    expect(harness.store.listJobs()).toEqual([]);
    expect(harness.store.listProfiles()).toEqual([]);
  });

  it('rejects templates for AS_IS and never inherits global templates for that mode', async () => {
    harness.store.saveMetadataSettings(
      demoBusinessTemplates.map((template) => ({ template })),
      0,
    );
    const response = await POST(
      request({
        name: 'そのまま',
        sourceRootPath: harness.sourceRoot,
        migrationMode: 'AS_IS',
        metadataTemplates: [],
      }),
    );
    const { job } = (await response.json()) as { job: MigrationJob };
    expect(harness.store.getAvailableJobMetadata(job.id)).toEqual([]);
    const invalid = await POST(
      request({
        name: '不正',
        sourceRootPath: harness.sourceRoot,
        migrationMode: 'AS_IS',
        metadataTemplates: [demoBusinessTemplates[0]],
      }),
    );
    expect(invalid.status).toBe(400);
    expect(harness.store.listJobs()).toHaveLength(1);
  });
});
