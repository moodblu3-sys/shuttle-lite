import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import {
  assertDestinationCurrent,
  browseDestinationFolder,
  collectJobDestinations,
  compatibleRoutingMetadata,
  ensureBoxLayout,
  loadCachedLayout,
  migrationTemplateSpec,
  saveLayout,
} from '@shuttle-lite/box';
import { sha1Buffer } from '@shuttle-lite/core';
import { migrate, MIGRATIONS, openDatabase, ShuttleStore } from '@shuttle-lite/db';
import { destinationsForJob } from '../apps/worker/src/context';
import { finalVerify } from '../apps/worker/src/steps/placement';
import { processCommands } from '../apps/worker/src/commands';
import { GET, POST } from '../apps/web/src/app/api/box-folders/route';
import { getBoxGateway, getConfig } from '../apps/web/src/lib/runtime';
import { approveItem, createHarness, runUntilIdle, type Harness } from './harness';

vi.mock('../apps/web/src/lib/runtime', () => ({ getConfig: vi.fn(), getBoxGateway: vi.fn() }));

describe('per-migration Box destination selection', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
    vi.mocked(getConfig).mockReturnValue(h.config);
    vi.mocked(getBoxGateway).mockReturnValue(h.gateway);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    h.cleanup();
  });

  async function tree(name = '営業部') {
    const root = await h.gateway.ensureFolder('0', name);
    const client = await h.gateway.ensureFolder(root.id, '顧客A');
    const contracts = await h.gateway.ensureFolder(client.id, '契約書');
    return { root, client, contracts };
  }

  it('browses existing folders and captures nested destinations without writing to Box', async () => {
    const { root, contracts } = await tree();
    await h.gateway.ensureFolder(root.id, '_staging');
    const bytes = Buffer.from('existing file');
    await h.gateway.uploadDirect({
      parentFolderId: root.id,
      name: 'file.txt',
      size: bytes.length,
      sha1Hex: sha1Buffer(bytes),
      content: () => Readable.from(bytes),
    });
    const create = vi.spyOn(h.gateway, 'ensureFolder');
    const listing = await browseDestinationFolder(h.gateway, root.id);
    expect(listing.folders.map((folder) => folder.name)).toEqual(['顧客A']);
    const snapshot = await collectJobDestinations(h.gateway, root.id, 'fake');
    expect(snapshot.entries).toHaveLength(3);
    expect(snapshot.entries[2]).toMatchObject({
      folderId: contracts.id,
      label: '営業部/顧客A/契約書',
      boxPath: '/営業部/顧客A/契約書',
    });
    expect(create).not.toHaveBeenCalled();
    expect(snapshot.entries.some((entry) => entry.key === 'LEGAL_CONTRACTS')).toBe(false);
  });

  it('rejects internal folders, their descendants, root, and malformed or inaccessible selections', async () => {
    const { root } = await tree();
    const internal = await h.gateway.ensureFolder(root.id, '_staging');
    const child = await h.gateway.ensureFolder(internal.id, 'job');
    for (const id of ['0', '../invalid', 'missing', internal.id, child.id]) {
      await expect(collectJobDestinations(h.gateway, id, 'fake')).rejects.toThrow();
    }
    await expect(collectJobDestinations(h.gateway, root.id, 'fake', [root.id])).rejects.toThrow();
  });

  it('browses shared folders using returned ancestry without requesting an inaccessible parent', async () => {
    const { root } = await tree();
    const get = vi.spyOn(h.gateway, 'getFolder').mockImplementation(async (id) => {
      if (id !== root.id) throw new Error('parent is not readable');
      return {
        ...root,
        parentFolderId: 'private-parent',
        ancestors: [
          { id: '0', name: 'All Files' },
          { id: 'private-parent', name: '部署' },
        ],
      };
    });
    expect((await browseDestinationFolder(h.gateway, root.id)).folder.id).toBe(root.id);
    expect(get).toHaveBeenCalledTimes(1);
    get.mockResolvedValue({ ...root, ancestors: [{ id: 'internal', name: '_staging' }] });
    await expect(browseDestinationFolder(h.gateway, root.id)).rejects.toThrow('処理用');
  });

  it('fails a partial or oversized traversal instead of accepting an incomplete catalog', async () => {
    const { root, client } = await tree();
    const original = h.gateway.listFolder.bind(h.gateway);
    vi.spyOn(h.gateway, 'listFolder').mockImplementation(async (id) => {
      if (id === client.id) throw new Error('not readable');
      return original(id);
    });
    await expect(collectJobDestinations(h.gateway, root.id, 'fake')).rejects.toThrow(
      'not readable',
    );
    vi.mocked(h.gateway.listFolder).mockResolvedValue(
      Array.from({ length: 201 }, (_, i) => ({
        type: 'folder' as const,
        id: 'child_' + i,
        name: 'child' + i,
      })),
    );
    vi.spyOn(h.gateway, 'getFolder').mockImplementation(async (id) =>
      id === root.id
        ? root
        : id === '0'
          ? { id: '0', name: 'root', parentFolderId: null }
          : { id, name: id, parentFolderId: root.id },
    );
    await expect(collectJobDestinations(h.gateway, root.id, 'fake')).rejects.toThrow('200');
  });

  it('stores immutable separate selections and rejects approval from another migration', async () => {
    const first = await tree('営業部');
    const second = await tree('法務部');
    h.writeSource('契約書.txt', '顧客Aの業務委託契約書');
    const jobs = [];
    for (const folders of [first, second]) {
      const profile = h.createProfile({ aiRoutingEnabled: false });
      const job = h.store.createJob({ profileId: profile.id, operatorLabel: '担当者' });
      const snapshot = await collectJobDestinations(h.gateway, folders.root.id, 'fake');
      h.store.saveJobDestinations(job.id, snapshot);
      h.store.enqueueCommand(job.id, 'START_JOB');
      jobs.push({ job, snapshot });
    }
    await runUntilIdle(h);
    const a = jobs[0]!;
    const b = jobs[1]!;
    const item = h.store.listItems(a.job.id)[0]!;
    expect(item.state).toBe('REVIEW_REQUIRED');
    expect(() => h.store.saveJobDestinations(a.job.id, b.snapshot)).toThrow();
    approveItem(h, item, b.snapshot.entries[2]!.key);
    await processCommands(h.ctx);
    expect(h.store.getItem(item.id)?.state).toBe('REVIEW_REQUIRED');
    expect(h.store.latestReviewCommand(a.job.id, item.id)?.state).toBe('REJECTED');
    approveItem(h, item, a.snapshot.entries[2]!.key);
    await runUntilIdle(h);
    expect(h.store.getItem(item.id)).toMatchObject({
      state: 'COMPLETED',
      boxFileId: item.boxFileId,
      finalFolderId: first.contracts.id,
    });
    expect(h.store.listItems(b.job.id)[0]?.state).toBe('REVIEW_REQUIRED');
    const reader = openDatabase({ path: h.config.sqlitePath });
    try {
      expect(new ShuttleStore(reader).getJobDestinations(a.job.id)).toEqual(a.snapshot);
    } finally {
      reader.close();
    }
  });

  it.each(['OUTSIDE_FOLDER', 'NEEDS_REVIEW'])(
    'passes folder context to AI and holds an unresolved destination: %s',
    async (suggestedDestinationKey) => {
      const { root } = await tree();
      h.writeSource('契約書.txt', '顧客Aの契約書');
      const job = h.store.createJob({ profileId: h.createProfile().id, operatorLabel: '担当者' });
      const snapshot = await collectJobDestinations(h.gateway, root.id, 'fake');
      h.store.saveJobDestinations(job.id, snapshot);
      const ai = vi.spyOn(h.gateway, 'extractStructured').mockResolvedValue({
        provider: 'test',
        confidence: null,
        references: [],
        fields: { suggestedDestinationKey, reason: '配置先を判断できません' },
      });
      h.store.enqueueCommand(job.id, 'START_JOB');
      await runUntilIdle(h);
      expect(ai).toHaveBeenCalledWith(
        expect.objectContaining({
          destinations: expect.arrayContaining([
            expect.objectContaining({ label: '営業部/顧客A/契約書' }),
          ]),
        }),
      );
      const item = h.store.listItems(job.id)[0]!;
      expect(item.state).toBe('REVIEW_REQUIRED');
      expect(h.store.getRouting(item.id)?.suggestedDestinationKey).toBeNull();
      expect(item.finalFolderId).toBeNull();
      if (suggestedDestinationKey === 'NEEDS_REVIEW')
        expect(h.store.getRouting(item.id)?.suggestionReason).toBe('配置先を判断できません');
    },
  );

  it('rechecks destination ancestry and stops before metadata or move after a folder moves', async () => {
    const { root, contracts } = await tree();
    h.writeSource('契約書.txt', '契約書');
    const job = h.store.createJob({
      profileId: h.createProfile({ aiRoutingEnabled: false }).id,
      operatorLabel: '担当者',
    });
    const snapshot = await collectJobDestinations(h.gateway, root.id, 'fake');
    h.store.saveJobDestinations(job.id, snapshot);
    h.store.enqueueCommand(job.id, 'START_JOB');
    await runUntilIdle(h);
    const item = h.store.listItems(job.id)[0]!;
    approveItem(h, item, snapshot.entries[2]!.key);
    const getFolder = h.gateway.getFolder.bind(h.gateway);
    vi.spyOn(h.gateway, 'getFolder').mockImplementation(async (id) =>
      id === contracts.id ? { ...contracts, parentFolderId: '0' } : getFolder(id),
    );
    const move = vi.spyOn(h.gateway, 'moveFile');
    const metadata = vi.spyOn(h.gateway, 'updateMetadata');
    await runUntilIdle(h);
    expect(move).not.toHaveBeenCalled();
    expect(metadata).not.toHaveBeenCalled();
    expect(h.store.getItem(item.id)?.state).toBe('NEEDS_REVIEW');
    await expect(assertDestinationCurrent(h.gateway, snapshot, contracts.id)).rejects.toThrow();
  });

  it('never creates sample destination paths in real mode, even with a legacy cache', async () => {
    const real = {
      ...h.config,
      box: { ...h.config.box, mode: 'real' as const, rootFolderId: h.ctx.layout.rootFolderId },
    };
    const createPath = vi.spyOn(h.gateway, 'ensureFolderPath');
    const layout = await ensureBoxLayout(h.gateway, real, h.catalog);
    expect(layout.destinations).toEqual({});
    expect(createPath).not.toHaveBeenCalled();
    saveLayout(real, { ...layout, destinations: h.ctx.layout.destinations });
    expect(loadCachedLayout(real)?.destinations).toEqual({});
    const job = h.store.createJob({ profileId: h.createProfile().id, operatorLabel: '担当者' });
    const ctx = { ...h.ctx, config: real };
    expect(() => destinationsForJob(ctx, job.id)).toThrow('移行先が設定されていません');
    h.store.enqueueCommand(job.id, 'START_JOB');
    await processCommands(ctx);
    expect(h.store.getJob(job.id)?.state).toBe('QUEUED');
    expect(h.store.listCommands(job.id)[0]?.state).toBe('REJECTED');
    h.store.saveJobDestinations(
      job.id,
      await collectJobDestinations(h.gateway, (await tree()).root.id, 'fake'),
    );
    expect(() => destinationsForJob(ctx, job.id)).toThrow('接続モード');
  });

  it('provides read-only browse and preview endpoints with safe errors', async () => {
    const { root } = await tree();
    const create = vi.spyOn(h.gateway, 'ensureFolder');
    const response = await GET(new Request('http://localhost/api/box-folders?folderId=' + root.id));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { folders: unknown[] }).folders).toHaveLength(1);
    const preview = await POST(
      new Request('http://localhost/api/box-folders', {
        method: 'POST',
        body: JSON.stringify({ folderId: root.id }),
      }),
    );
    expect(await preview.json()).toMatchObject({ folderId: root.id, folderCount: 3 });
    expect(create).not.toHaveBeenCalled();
    expect(h.store.listJobs()).toHaveLength(0);
    vi.spyOn(h.gateway, 'listFolder').mockRejectedValue(new Error('sensitive transport detail'));
    const failed = await GET(new Request('http://localhost/api/box-folders?folderId=' + root.id));
    expect(failed.status).toBe(400);
    expect(await failed.text()).not.toContain('sensitive');
  });

  it('finishes and verifies a selected destination with an existing fixed-enum template', async () => {
    const { root, contracts } = await tree();
    await h.gateway.createMetadataTemplate(
      migrationTemplateSpec('enterprise', 'migration', ['LEGAL_CONTRACTS']),
    );
    h.writeSource('契約書.txt', '契約書');
    const job = h.store.createJob({
      profileId: h.createProfile({ aiRoutingEnabled: false }).id,
      operatorLabel: '担当者',
    });
    const snapshot = await collectJobDestinations(h.gateway, root.id, 'fake');
    h.store.saveJobDestinations(job.id, snapshot);
    h.store.enqueueCommand(job.id, 'START_JOB');
    await runUntilIdle(h);
    const item = h.store.listItems(job.id)[0]!;
    const update = h.gateway.updateMetadata.bind(h.gateway);
    vi.spyOn(h.gateway, 'updateMetadata').mockImplementation(async (id, values) => {
      expect(values).not.toHaveProperty('approvedDestinationKey');
      expect(values).not.toHaveProperty('suggestedDestinationKey');
      await update(id, values);
    });
    approveItem(h, item, snapshot.entries[2]!.key);
    await runUntilIdle(h);
    const completed = h.store.getItem(item.id)!;
    expect(completed).toMatchObject({
      state: 'COMPLETED',
      finalFolderId: contracts.id,
      boxFileId: item.boxFileId,
    });
    const metadata = await h.gateway.getMetadata(item.boxFileId!);
    expect(metadata?.routingReason).toContain(snapshot.entries[2]!.key);
    vi.spyOn(h.gateway, 'getMetadata').mockResolvedValue({
      ...metadata,
      routingReason: 'wrong destination',
    });
    const ctx = { ...(await h.jobContext(job.id)), ...destinationsForJob(h.ctx, job.id) };
    await expect(finalVerify(ctx, completed)).rejects.toMatchObject({
      category: 'METADATA_SCHEMA',
    });
  });

  it('supports old enum metadata templates without modifying them or losing the stored destination', () => {
    const old = migrationTemplateSpec('enterprise', 'migration', ['LEGAL_CONTRACTS']);
    const values = {
      approvedDestinationKey: 'DEST_ABC',
      suggestedDestinationKey: 'DEST_ABC',
      routingReason: '配置先: /営業部/顧客A/契約書',
    };
    expect(compatibleRoutingMetadata(values, old)).toEqual({ routingReason: values.routingReason });
    const current = migrationTemplateSpec('enterprise', 'migration', []);
    expect(compatibleRoutingMetadata(values, current)).toEqual(values);
    expect(old.fields.find((field) => field.key === 'approvedDestinationKey')?.options).toEqual([
      'LEGAL_CONTRACTS',
    ]);
  });
});

describe('destination snapshot schema upgrade', () => {
  it('keeps old jobs intact without assigning any sample destination', () => {
    const db = openDatabase({ path: ':memory:' });
    try {
      for (const migration of MIGRATIONS.filter((m) => m.version <= 3)) db.exec(migration.sql);
      db.pragma('user_version = 3');
      const store = new ShuttleStore(db);
      const profile = store.createProfile({
        name: '既存',
        sourceRootPath: '/source',
        targetStagingFolderId: 'staging',
        destinationCatalogId: 'default',
        proxyProfileName: 'none',
        metadataTemplateKey: 'migration',
        fileConcurrency: 1,
        chunkConcurrency: 1,
        aiRoutingEnabled: true,
        snowflakeLoggingEnabled: true,
        conflictPolicy: 'RENAME',
      });
      const at = '2026-09-01T00:00:00.000Z';
      db.prepare(
        `INSERT INTO migration_jobs (id, profile_id, state, operator_label, created_at, updated_at, name)
        VALUES (?,?,?,?,?,?,?)`,
      ).run('old-job', profile.id, 'QUEUED', 'tester', at, at, '既存');
      migrate(db);
      const migrated = store.getJob('old-job');
      migrate(db);
      expect(store.getJob('old-job')).toEqual(migrated);
      expect(migrated).toMatchObject({
        id: 'old-job',
        name: '既存',
        profileId: profile.id,
        operatorLabel: 'tester',
        createdAt: at,
        testMode: false,
        cleanupState: 'NONE',
        cleanupMessage: null,
      });
      expect(store.getJobDestinations('old-job')).toBeNull();
    } finally {
      db.close();
    }
  });
});
