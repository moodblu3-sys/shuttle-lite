import { describe, expect, it } from 'vitest';
import { migrate, MIGRATIONS, openDatabase, ShuttleStore } from '@shuttle-lite/db';

describe('migration names on existing databases', () => {
  it('preserves existing titles, jobs, sources and commands when upgrading from schema 2', () => {
    const db = openDatabase({ path: ':memory:' });
    try {
      for (const migration of MIGRATIONS.filter((entry) => entry.version <= 2))
        db.exec(migration.sql);
      db.pragma('user_version = 2');
      const store = new ShuttleStore(db);
      const profile = store.createProfile({
        name: '既存の営業資料',
        sourceRootPath: '/existing/source',
        targetStagingFolderId: 'staging',
        destinationCatalogId: 'default',
        proxyProfileName: 'none',
        metadataTemplateKey: 'migration',
        fileConcurrency: 3,
        chunkConcurrency: 3,
        aiRoutingEnabled: true,
        snowflakeLoggingEnabled: true,
        conflictPolicy: 'RENAME',
      });
      db.prepare(
        `INSERT INTO migration_jobs (id, profile_id, state, operator_label, created_at, updated_at)
        VALUES (?, ?, 'QUEUED', 'existing operator', '2026-09-22', '2026-09-22')`,
      ).run('existing-job', profile.id);
      const command = store.enqueueCommand('existing-job', 'START_JOB');

      migrate(db);
      migrate(db);

      expect(store.getJob('existing-job')).toMatchObject({
        name: profile.name,
        profileId: profile.id,
        state: 'QUEUED',
      });
      expect(store.getProfile(profile.id)).toEqual(profile);
      expect(store.listCommands('existing-job')).toEqual([command]);
      const first = store.createJob({
        name: '同じ移行名',
        profileId: profile.id,
        operatorLabel: 'tester',
      });
      const second = store.createJob({
        name: '同じ移行名',
        profileId: profile.id,
        operatorLabel: 'tester',
      });
      expect(first.id).not.toBe(second.id);
      expect(store.getJob(first.id)?.name).toBe('同じ移行名');
      expect(store.getJob(second.id)?.name).toBe('同じ移行名');
    } finally {
      db.close();
    }
  });
});
