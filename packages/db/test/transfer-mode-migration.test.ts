import { describe, expect, it } from 'vitest';
import { migrate, MIGRATIONS, openDatabase, ShuttleStore } from '@shuttle-lite/db';

describe('direct transfer schema upgrade', () => {
  it('keeps existing AS_IS jobs staged and defaults only new AS_IS jobs to final', () => {
    const db = openDatabase({ path: ':memory:' });
    try {
      for (const migration of MIGRATIONS.filter((m) => m.version <= 14)) db.exec(migration.sql);
      db.pragma('user_version = 14');
      const store = new ShuttleStore(db);
      const profile = store.createProfile({
        name: '既存ジョブ',
        sourceRootPath: '/source',
        targetStagingFolderId: 'staging',
        destinationCatalogId: 'default',
        proxyProfileName: 'none',
        metadataTemplateKey: 'migration',
        fileConcurrency: 2,
        chunkConcurrency: 2,
        aiRoutingEnabled: false,
        snowflakeLoggingEnabled: true,
        conflictPolicy: 'RENAME',
      });
      db.prepare(
        `INSERT INTO migration_jobs
        (id,profile_id,state,operator_label,created_at,updated_at,migration_mode,staging_folder_id)
        VALUES ('existing',?,'RUNNING','担当者','2026-09-29','2026-09-29','AS_IS','old-staging')`,
      ).run(profile.id);
      migrate(db);
      migrate(db);
      expect(store.getJob('existing')).toMatchObject({
        migrationMode: 'AS_IS',
        transferMode: 'STAGED',
        state: 'RUNNING',
        stagingFolderId: 'old-staging',
      });
      expect(
        store.createJob({ profileId: profile.id, operatorLabel: '担当者', migrationMode: 'AS_IS' })
          .transferMode,
      ).toBe('FINAL');
      expect(store.createJob({ profileId: profile.id, operatorLabel: '担当者' }).transferMode).toBe(
        'STAGED',
      );
    } finally {
      db.close();
    }
  });
});
