import { hostname } from 'node:os';
import { ShuttleError, toShuttleError, type MigrationItem } from '@shuttle-lite/core';
import type { WorkerContext } from './context';

/** Runs only after transfer work has released its lease. No folder-wide deletion. */
export async function processTestCleanup(ctx: WorkerContext): Promise<boolean> {
  recoverDeadCleanupLeases(ctx);
  const job = ctx.store.claimTestCleanup(ctx.workerId);
  if (!job) return false;
  let deleted = 0;
  let unresolved = 0;
  const items: MigrationItem[] = [];
  try {
    const snapshot = ctx.store.getJobDestinations(job.id);
    if (
      (!snapshot && ctx.gateway.kind === 'http') ||
      (snapshot && snapshot.mode !== ctx.config.box.mode)
    ) {
      throw new ShuttleError('STATE_INVALID', '移行時とBox接続モードが異なります');
    }
    for (let offset = 0; ; offset += 500) {
      const page = ctx.store.listItems(job.id, { offset, limit: 500 });
      items.push(...page);
      if (page.length < 500) break;
    }
    for (const item of items) {
      const session = ctx.store.getOpenSession(item.id);
      if (session) {
        try {
          await ctx.gateway.abortUploadSession(session.boxSessionId);
          ctx.store.setSessionState(session.id, 'ABORTED');
        } catch (error) {
          unresolved += 1;
          ctx.store.appendEvent({
            jobId: job.id,
            itemId: item.id,
            phase: 'FINAL_VERIFY',
            status: 'FAILED',
            message: `分割転送の終了を確認できません: ${toShuttleError(error).message}`,
          });
        }
      }
      if (!item.boxFileId) {
        // Never guess the ID of an upload whose result was not recorded.
        if (item.state === 'UPLOADING' || item.state === 'UNKNOWN_OUTCOME' || item.uploadStrategy) {
          unresolved += 1;
        }
        continue;
      }
      if (ctx.store.wasTestFileDeleted(job.id, item.boxFileId)) {
        deleted += 1;
        continue;
      }
      try {
        const file = await ctx.gateway.getFile(item.boxFileId);
        if (!file)
          throw new ShuttleError(
            'BOX_NOT_FOUND',
            '対象の所在を確認できません。Box上で確認してください',
          );
        const businessMode = ctx.store.getJobMetadata(job.id) !== null;
        const owned = businessMode
          ? ctx.store.hasUploadRecord(job.id, item.id, file.id)
          : await ctx.gateway
              .getMetadata(file.id)
              .then(
                (metadata) =>
                  metadata?.migrationJobId === job.id && metadata?.migrationItemId === item.id,
              );
        if (!owned) {
          throw new ShuttleError(
            'STATE_INVALID',
            'このテストが転送したファイルであることを確認できません',
          );
        }
        if (
          !item.boxSha1 ||
          !item.boxFileVersionId ||
          !item.sourceSha1 ||
          file.sha1 !== item.sourceSha1 ||
          file.size !== item.sourceSize ||
          file.size !== item.boxSize ||
          file.sha1 !== item.boxSha1 ||
          file.versionId !== item.boxFileVersionId
        ) {
          throw new ShuttleError(
            'APPROVAL_STALE',
            '転送後に内容またはバージョンが変更されています',
          );
        }
        const allowedParents = [job.stagingFolderId, item.finalFolderId].filter(Boolean);
        if (!file.parentFolderId || !allowedParents.includes(file.parentFolderId)) {
          throw new ShuttleError('STATE_INVALID', 'ファイルがテストの配置先から移動されています');
        }
        if (!file.etag) throw new ShuttleError('STATE_INVALID', '削除直前の変更確認ができません');
        await ctx.gateway.deleteTestFile(file.id, file.etag);
        ctx.store.recordTestFileDeleted(job.id, file.id);
        deleted += 1;
        ctx.store.appendEvent({
          jobId: job.id,
          itemId: item.id,
          phase: 'FINAL_VERIFY',
          status: 'SUCCEEDED',
          boxFileId: file.id,
          message: 'テスト終了に伴い転送ファイルを削除しました',
        });
      } catch (error) {
        unresolved += 1;
        ctx.store.appendEvent({
          jobId: job.id,
          itemId: item.id,
          phase: 'FINAL_VERIFY',
          status: 'FAILED',
          boxFileId: item.boxFileId,
          message: `テスト削除を見送りました: ${toShuttleError(error).message}`,
        });
      }
    }
    // Detect untracked/orphaned staging files, but never remove them by folder/name.
    if (job.stagingFolderId) {
      const tracked = new Set(items.map((item) => item.boxFileId));
      const remaining = await ctx.gateway.listFolder(job.stagingFolderId);
      unresolved += remaining.filter((entry) => !tracked.has(entry.id)).length;
    }
    ctx.store.finishTestCleanup(
      job.id,
      unresolved ? 'FAILED' : 'DONE',
      unresolved
        ? `${deleted}件削除済み。${unresolved}件は未解決です。詳細ログを確認してください。`
        : `${deleted}件のテストファイルを削除しました。`,
    );
  } catch (error) {
    ctx.store.finishTestCleanup(
      job.id,
      'FAILED',
      `${deleted}件削除済み。${toShuttleError(error).message}`,
    );
  } finally {
    ctx.store.releaseLease(job.id, ctx.workerId);
  }
  return true;
}

/** Reclaim only a provably exited process on this host, never a slow/live worker. */
export function recoverDeadCleanupLeases(ctx: WorkerContext): void {
  const prefix = `${hostname()}-`;
  for (const job of ctx.store.listLockedTestCleanups()) {
    const owner = job.leaseOwner!;
    if (!owner.startsWith(prefix)) continue;
    const pidText = owner.slice(prefix.length).split('-')[0]!;
    if (!/^[1-9][0-9]*$/.test(pidText)) continue;
    const pid = Number(pidText);
    if (!Number.isSafeInteger(pid) || pid > 2147483647) continue;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        ctx.store.recoverTestCleanup(job.id, owner);
      }
    }
  }
}
