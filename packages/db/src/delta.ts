import type { MigrationFolder } from '@shuttle-lite/core';
import type { ScannedItemInput, ShuttleStore } from './store';

export interface VersionTarget {
  id: string;
  name: string;
  parentFolderId: string | null;
  versionId: string | null;
  sha1: string;
  size: number;
  etag?: string;
}
export type DeltaAction =
  'ADD' | 'UPDATE' | 'RETRY' | 'UNCHANGED' | 'CONFLICT' | 'REMOVED' | 'BOX_CHANGED';
export interface DeltaEntry {
  path: string;
  action: DeltaAction;
  reason: string | null;
  source: Omit<ScannedItemInput, 'id' | 'jobId'> | null;
  sha1: string | null;
  target: VersionTarget | null;
}
export interface DeltaPlan {
  excludedPaths?: string[];
  id: string;
  rootJobId: string;
  createdAt: string;
  signature: string;
  folders: MigrationFolder[];
  entries: DeltaEntry[];
}
export function rootJobId(store: ShuttleStore, jobId: string): string {
  const row = store.db
    .prepare('SELECT root_job_id AS id FROM delta_runs WHERE job_id=?')
    .get(jobId) as { id: string } | undefined;
  return row?.id ?? jobId;
}
export function migrationRuns(store: ShuttleStore, jobId: string) {
  const root = rootJobId(store, jobId);
  const rows = store.db
    .prepare(
      `SELECT id FROM migration_jobs WHERE id=? OR id IN
    (SELECT job_id FROM delta_runs WHERE root_job_id=?) ORDER BY created_at, rowid`,
    )
    .all(root, root) as { id: string }[];
  return rows.map((row) => store.getJob(row.id)!);
}
export function getDeltaPlan(
  store: ShuttleStore,
  jobId: string,
): (DeltaPlan & { startedJobId: string | null }) | null {
  const row = store.db
    .prepare(
      `SELECT snapshot, started_job_id AS startedJobId FROM delta_plans
    WHERE root_job_id=? ORDER BY rowid DESC LIMIT 1`,
    )
    .get(rootJobId(store, jobId)) as { snapshot: string; startedJobId: string | null } | undefined;
  return row
    ? { ...(JSON.parse(row.snapshot) as DeltaPlan), startedJobId: row.startedJobId }
    : null;
}
export function executionPlan(store: ShuttleStore, jobId: string): DeltaPlan | null {
  const row = store.db
    .prepare(
      `SELECT p.snapshot FROM delta_plans p JOIN delta_runs r ON r.plan_id=p.id WHERE r.job_id=?`,
    )
    .get(jobId) as { snapshot: string } | undefined;
  return row ? (JSON.parse(row.snapshot) as DeltaPlan) : null;
}
export function getVersionTarget(
  store: ShuttleStore,
  itemId: string,
): (VersionTarget & { attempted: boolean }) | null {
  const row = store.db
    .prepare('SELECT snapshot, attempted FROM version_targets WHERE item_id=?')
    .get(itemId) as { snapshot: string; attempted: number } | undefined;
  return row
    ? { ...(JSON.parse(row.snapshot) as VersionTarget), attempted: row.attempted === 1 }
    : null;
}
export function saveVersionTarget(store: ShuttleStore, itemId: string, target: VersionTarget) {
  store.db
    .prepare('INSERT INTO version_targets (item_id,snapshot) VALUES (?,?)')
    .run(itemId, JSON.stringify(target));
}
