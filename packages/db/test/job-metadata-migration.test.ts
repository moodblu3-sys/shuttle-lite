import { describe, expect, it } from 'vitest';
import { migrate, MIGRATIONS, openDatabase, ShuttleStore } from '@shuttle-lite/db';
import type { TemplateMapping } from '@shuttle-lite/core';

describe('per-job metadata selection schema upgrade', () => {
  it('preserves old live selections while isolating new snapshots, including no selection', () => {
    const db = openDatabase({ path: ':memory:' });
    try {
      for (const migration of MIGRATIONS.filter((entry) => entry.version <= 13))
        db.exec(migration.sql);
      db.pragma('user_version = 13');
      const store = new ShuttleStore(db);
      const profile = store.createProfile({
        name: '既存の移行元',
        sourceRootPath: '/source',
        targetStagingFolderId: 'staging',
        destinationCatalogId: 'default',
        proxyProfileName: 'none',
        metadataTemplateKey: 'migration',
        fileConcurrency: 2,
        chunkConcurrency: 2,
        aiRoutingEnabled: true,
        snowflakeLoggingEnabled: true,
        conflictPolicy: 'RENAME',
      });
      const create = () => store.createJob({ profileId: profile.id, operatorLabel: '担当者' });
      const old = { id: 'old-job' };
      db.prepare(
        `INSERT INTO migration_jobs
        (id,profile_id,state,operator_label,created_at,updated_at)
        VALUES (?,?,'QUEUED','担当者','2026-09-22','2026-09-22')`,
      ).run(old.id, profile.id);
      const mappings: TemplateMapping[] = [
        {
          template: {
            scope: 'enterprise_123',
            templateKey: 'contract',
            displayName: '契約書',
            fields: [{ key: 'title', displayName: '件名', type: 'string' }],
          },
        },
      ];
      db.prepare('INSERT INTO job_metadata VALUES (?, ?)').run(old.id, '[]');
      store.saveMetadataSettings(mappings, 0);
      migrate(db);
      migrate(db);
      expect(store.getAvailableJobMetadata(old.id)).toEqual(mappings);
      expect(store.getJobMetadata(old.id)).toEqual([]);
      const selected = create();
      store.saveJobMetadata(selected.id, mappings, 'JOB');
      const empty = create();
      store.saveJobMetadata(empty.id, [], 'JOB');
      expect(store.getAvailableJobMetadata(empty.id)).toEqual([]);
      store.saveMetadataSettings([], 1);
      expect(store.getAvailableJobMetadata(old.id)).toEqual([]);
      expect(store.getAvailableJobMetadata(selected.id)).toEqual(mappings);
      expect(store.getAvailableJobMetadata(empty.id)).toEqual([]);
    } finally {
      db.close();
    }
  });
});
