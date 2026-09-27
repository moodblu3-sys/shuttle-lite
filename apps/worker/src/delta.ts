import { createHash } from 'node:crypto';
import { basename, posix } from 'node:path';
import {
  migrationItemId,
  ShuttleError,
  type JobCommandRecord,
  type MigrationItem,
  type MigrationFolder,
} from '@shuttle-lite/core';
import {
  getDeltaPlan,
  getVersionTarget,
  migrationRuns,
  rootJobId,
  saveVersionTarget,
  type DeltaPlan,
  type DeltaEntry,
} from '@shuttle-lite/db';
import type { WorkerContext } from './context';
import { destinationsForJob } from './context';
import { LocalSourceAdapter } from './source/local';

export function assertDeltaIdle(ctx: WorkerContext, jobId: string, commandId?: string) {
  const runs = migrationRuns(ctx.store, jobId);
  const root = runs[0];
  if (!root || root.migrationMode !== 'AS_IS' || root.testMode || root.cleanupState !== 'NONE')
    throw new ShuttleError('STATE_INVALID', '差分移行は通常の「そのまま移行」で利用できます。');
  for (const run of runs) {
    if (
      !['COMPLETED', 'FAILED'].includes(run.state) ||
      (run.leaseExpiresAt && Date.parse(run.leaseExpiresAt) > Date.now())
    )
      throw new ShuttleError(
        'STATE_INVALID',
        '実行中・一時停止中の移行を終了してから差分を確認してください。',
      );
    if (
      ctx.store
        .listJobOperations(run.id)
        .some((c) => c.id !== commandId && ['PENDING', 'CLAIMED'].includes(c.state))
    )
      throw new ShuttleError('STATE_INVALID', 'ほかの操作が完了してから実行してください。');
  }
  return root;
}

function allItems(ctx: WorkerContext, jobId: string): MigrationItem[] {
  const result: MigrationItem[] = [];
  for (let offset = 0; ; offset += 500) {
    const page = ctx.store.listItems(jobId, { offset, limit: 500 });
    result.push(...page);
    if (page.length < 500) return result;
  }
}
function signature(ctx: WorkerContext, jobId: string): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        migrationRuns(ctx.store, jobId).map((run) => [
          run.id,
          run.state,
          allItems(ctx, run.id).map((i) => [
            i.id,
            i.updatedAt,
            i.state,
            i.boxFileId,
            i.boxFileVersionId,
          ]),
        ]),
      ),
    )
    .digest('hex');
}

/** Boxへの書き込みは行わない。全走査成功後だけ一覧を確定する。 */
export async function checkDelta(
  ctx: WorkerContext,
  command: JobCommandRecord,
): Promise<() => void> {
  const root = assertDeltaIdle(ctx, command.jobId, command.id);
  destinationsForJob(ctx, root.id);
  const initialSignature = signature(ctx, root.id);
  const profile = ctx.store.getProfile(root.profileId)!;
  const source = new LocalSourceAdapter({ rootPath: profile.sourceRootPath });
  await source.verifyRoot();
  const rootsBefore = await import('node:fs/promises').then((fs) =>
    fs.stat(profile.sourceRootPath),
  );
  const latest = new Map<string, MigrationItem>();
  const completed = new Map<string, MigrationItem>();
  const folders = new Map<string, MigrationFolder>();
  for (const run of migrationRuns(ctx.store, root.id)) {
    for (const i of allItems(ctx, run.id)) {
      latest.set(i.sourceRelativePath, i);
      if (i.state === 'COMPLETED') completed.set(i.sourceRelativePath, i);
    }
    for (const f of ctx.store.listMigrationFolders(run.id))
      if (f.boxFolderId) folders.set(f.relativePath, f);
  }
  const selected = ctx.store.getJobDestinations(root.id)!;
  // 保存済み階層の移動・消失は勝手に作り直さない。
  for (const f of folders.values()) {
    const current = await ctx.gateway.getFolder(f.boxFolderId!);
    const parent =
      f.parentPath === null ? selected.rootFolderId : folders.get(f.parentPath)?.boxFolderId;
    if (!current || current.name !== f.name || current.parentFolderId !== parent)
      throw new ShuttleError('BOX_CONFLICT', '移行先フォルダーが削除・移動・改名されています。');
  }
  const scannedFolders: MigrationFolder[] = [];
  for await (const path of source.scanDirectories()) {
    scannedFolders.push(
      folders.get(path) ?? {
        relativePath: path,
        name: path ? posix.basename(path) : basename(profile.sourceRootPath),
        parentPath: path ? (posix.dirname(path) === '.' ? '' : posix.dirname(path)) : null,
        boxFolderId: null,
      },
    );
  }
  const entries: DeltaEntry[] = [];
  const seen = new Set<string>();
  for await (const info of source.scan()) {
    const digest = await source.digest(info);
    const after = await source.stat(info);
    if (
      after.size !== info.size ||
      after.modifiedAt !== info.modifiedAt ||
      digest.bytes !== info.size
    )
      throw new ShuttleError(
        'SOURCE_CHANGED',
        '差分確認中に移行元が変わりました。確認し直してください。',
      );
    seen.add(info.relativePath);
    const last = latest.get(info.relativePath);
    const previous = completed.get(info.relativePath);
    const entry: DeltaEntry = {
      path: info.relativePath,
      action: last ? 'RETRY' : 'ADD',
      reason: null,
      sha1: digest.sha1,
      target: null,
      source: {
        sourceRelativePath: info.relativePath,
        sourceAbsolutePath: info.locator,
        sourceFileName: info.fileName,
        sourceSize: info.size,
        sourceModifiedAt: info.modifiedAt,
        sourceInode: info.externalId,
        fileType: info.fileType,
      },
    };
    if (
      last &&
      last.state !== 'COMPLETED' &&
      last.state !== 'SKIPPED' &&
      (last.uploadStrategy || last.boxFileId || getVersionTarget(ctx.store, last.id))
    ) {
      entry.action = 'CONFLICT';
      entry.reason = '前回の転送結果を確認してください。失敗分の再試行で復旧できます。';
    } else if (previous?.boxFileId) {
      const file = await ctx.gateway.getFile(previous.boxFileId);
      if (
        !file ||
        file.name !== previous.finalName ||
        file.parentFolderId !== previous.finalFolderId
      ) {
        entry.action = 'CONFLICT';
        entry.reason = 'Box側で削除・移動・改名されています。';
      } else if (file.sha1 === digest.sha1 && file.size === info.size) {
        entry.action = 'UNCHANGED';
        entry.target = file;
      } else if (previous.sourceSha1 === digest.sha1 && previous.sourceSize === info.size) {
        entry.action = 'BOX_CHANGED';
        entry.reason = 'Box側の内容を維持します。';
      } else if (
        file.versionId !== previous.boxFileVersionId ||
        file.sha1 !== previous.boxSha1 ||
        file.size !== previous.boxSize ||
        !file.etag
      ) {
        entry.action = 'CONFLICT';
        entry.reason = '移行元とBoxの両方が変更されています。';
      } else {
        entry.action = 'UPDATE';
        entry.target = file;
      }
    }
    if (!previous && entry.action !== 'CONFLICT') {
      const parentPath =
        posix.dirname(info.relativePath) === '.' ? '' : posix.dirname(info.relativePath);
      const parentId = folders.get(parentPath)?.boxFolderId;
      if (parentId && profile.conflictPolicy === 'OVERWRITE') {
        const existing = await ctx.gateway.findFileByName(parentId, info.fileName);
        if (existing) {
          if (!existing.etag) {
            entry.action = 'CONFLICT';
            entry.reason = '更新先の状態を確認できません。';
          } else {
            entry.target = existing;
            entry.action = 'UPDATE';
          }
        }
      }
    }
    entries.push(entry);
  }
  for (const [path] of latest)
    if (!seen.has(path))
      entries.push({
        path,
        action: 'REMOVED',
        reason: 'Box側は残します。',
        source: null,
        sha1: null,
        target: null,
      });
  await source.verifyRoot();
  const rootsAfter = await import('node:fs/promises').then((fs) => fs.stat(profile.sourceRootPath));
  if (rootsAfter.dev !== rootsBefore.dev || rootsAfter.ino !== rootsBefore.ino)
    throw new ShuttleError('SOURCE_READ', '移行元への接続が変わりました。確認し直してください。');
  const plan: DeltaPlan = {
    id: command.id,
    rootJobId: root.id,
    createdAt: new Date().toISOString(),
    signature: initialSignature,
    folders: scannedFolders,
    entries,
  };
  return () => {
    assertDeltaIdle(ctx, root.id, command.id);
    if (signature(ctx, root.id) !== initialSignature)
      throw new ShuttleError(
        'STATE_INVALID',
        '移行結果が変わりました。差分を確認し直してください。',
      );
    ctx.store.db
      .prepare('INSERT INTO delta_plans (id,root_job_id,snapshot,created_at) VALUES (?,?,?,?)')
      .run(plan.id, root.id, JSON.stringify(plan), plan.createdAt);
  };
}

/** 各回を別jobとして保存し、元の移行と結果・レポートの履歴を共有する。 */
export function startDelta(ctx: WorkerContext, command: JobCommandRecord): void {
  const root = assertDeltaIdle(ctx, command.jobId, command.id);
  const plan = getDeltaPlan(ctx.store, root.id);
  const latestCheck = ctx.store.db
    .prepare(
      `SELECT id,state FROM job_commands WHERE type='CHECK_DELTA'
    AND (job_id=? OR job_id IN (SELECT job_id FROM delta_runs WHERE root_job_id=?))
    ORDER BY rowid DESC LIMIT 1`,
    )
    .get(root.id, root.id) as { id: string; state: string } | undefined;
  if (latestCheck?.id !== plan?.id || latestCheck?.state !== 'DONE')
    throw new ShuttleError('STATE_INVALID', '最新の差分確認を完了してください。');
  if (
    !plan ||
    plan.id !== command.payload.planId ||
    plan.startedJobId ||
    plan.signature !== signature(ctx, root.id)
  )
    throw new ShuttleError('STATE_INVALID', '差分を確認し直してください。');
  const excluded = command.payload.excludedPaths ?? [];
  if (
    !Array.isArray(excluded) ||
    excluded.some((p) => typeof p !== 'string' || !plan.entries.some((e) => e.path === p))
  )
    throw new ShuttleError('STATE_INVALID', '対象ファイルの指定が不正です。');
  const active = plan.entries.filter(
    (e) => ['ADD', 'UPDATE', 'RETRY'].includes(e.action) && !excluded.includes(e.path),
  );
  if (!active.length && !plan.folders.some((f) => !f.boxFolderId))
    throw new ShuttleError('STATE_INVALID', '移行対象がありません。');
  const run = ctx.store.createJob({
    profileId: root.profileId,
    operatorLabel: root.operatorLabel,
    name: root.name ?? undefined,
    migrationMode: 'AS_IS',
  });
  ctx.store.db
    .prepare('INSERT INTO delta_runs (job_id,root_job_id,plan_id) VALUES (?,?,?)')
    .run(run.id, root.id, plan.id);
  ctx.store.db
    .prepare('UPDATE delta_plans SET started_job_id=?, snapshot=? WHERE id=?')
    .run(run.id, JSON.stringify({ ...plan, excludedPaths: excluded }), plan.id);
  ctx.store.saveJobDestinations(run.id, ctx.store.getJobDestinations(root.id)!);
  ctx.store.saveJobMetadata(run.id, []);
  for (const f of plan.folders) {
    ctx.store.saveScannedFolder(run.id, f);
    if (f.boxFolderId) ctx.store.setMigrationFolderId(run.id, f.relativePath, f.boxFolderId);
  }
  for (const entry of active) {
    const id = migrationItemId(run.id, entry.path);
    ctx.store.upsertScannedItem({ ...entry.source!, id, jobId: run.id });
    ctx.store.updateItem(id, { sourceSha1: entry.sha1 });
    if (entry.target) saveVersionTarget(ctx.store, id, entry.target);
  }
  ctx.store.refreshJobTotals(run.id);
  ctx.store.setJobState(run.id, 'RUNNING', { startedAt: new Date().toISOString() });
}

export function isDeltaRun(ctx: WorkerContext, jobId: string) {
  return rootJobId(ctx.store, jobId) !== jobId;
}
