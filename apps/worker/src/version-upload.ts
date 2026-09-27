import { ShuttleError, type MigrationItem } from '@shuttle-lite/core';
import { getVersionTarget, saveVersionTarget, rootJobId } from '@shuttle-lite/db';
import type { JobContext } from './context';
import { preservedDestination } from './folder-tree';

/** 更新先を送信前に固定する。再試行時に新しいetagへ差し替えない。 */
export async function prepareVersionTarget(ctx: JobContext, item: MigrationItem): Promise<boolean> {
  if (ctx.job.migrationMode !== 'AS_IS') return false;
  let target = getVersionTarget(ctx.store, item.id);
  if (!target && ctx.profile.conflictPolicy === 'OVERWRITE') {
    if (ctx.job.testMode)
      throw new ShuttleError('CONFIG_INVALID', 'テストモードでは上書きできません。');
    const folderId = await preservedDestination(ctx, item);
    const existing = await ctx.gateway.findFileByName(folderId, item.sourceFileName);
    if (existing && rootJobId(ctx.store, item.jobId) !== item.jobId)
      throw new ShuttleError(
        'BOX_CONFLICT',
        '差分確認後に同名ファイルが見つかりました。確認し直してください。',
      );
    if (existing) {
      saveVersionTarget(ctx.store, item.id, existing);
      target = getVersionTarget(ctx.store, item.id);
    }
  }
  if (!target) return false;
  if (!target.etag) throw new ShuttleError('BOX_CONFLICT', '更新先の状態を確認できません。');
  const folderId = await preservedDestination(ctx, item);
  const current = await ctx.gateway.getFile(target.id);
  if (!current || current.parentFolderId !== folderId || current.name !== target.name)
    throw new ShuttleError('BOX_CONFLICT', '更新先が削除・移動・改名されています。');
  const matches = current.sha1 === item.sourceSha1 && current.size === item.sourceSize;
  if (current.etag !== target.etag && !(target.attempted && matches))
    throw new ShuttleError('BOX_CONFLICT', 'Box側で変更されています。差分を確認し直してください。');
  ctx.store.updateItem(item.id, {
    finalFolderId: folderId,
    finalName: target.name,
    boxFileId: target.id,
    uploadStrategy: item.sourceSize > ctx.config.limits.directUploadMaxBytes ? 'CHUNKED' : 'DIRECT',
  });
  if (matches) {
    // 送信結果不明でも同じID・配置・内容を照合して二重versionを避ける。
    let state = ctx.store.getItem(item.id)!.state;
    for (const to of ['READY', 'UPLOADING', 'STAGED'] as const) {
      if (
        (to === 'READY' && state === 'PREFLIGHT') ||
        (to === 'UPLOADING' && state === 'READY') ||
        (to === 'STAGED' && state === 'UPLOADING')
      ) {
        ctx.store.transitionItem({
          itemId: item.id,
          to,
          telemetry: ctx.telemetry,
          patch:
            to === 'STAGED'
              ? {
                  boxFileVersionId: current.versionId,
                  boxSize: current.size,
                  boxSha1: current.sha1,
                }
              : {},
        });
        state = to;
      }
    }
  } else if (ctx.store.getItem(item.id)?.state === 'PREFLIGHT') {
    ctx.store.transitionItem({ itemId: item.id, to: 'READY', telemetry: ctx.telemetry });
  }
  return true;
}
