import { ShuttleError, type MigrationItem } from '@shuttle-lite/core';
import type { ShuttleStore } from '@shuttle-lite/db';
import type { JobContext } from './context';
import { preservedDestination } from './folder-tree';
import { resolveName } from './steps/placement';

interface DirectTarget {
  folder_id: string;
  name: string;
  attempted: number;
}

export function getDirectTarget(store: ShuttleStore, itemId: string): DirectTarget | null {
  return (
    (store.db.prepare('SELECT * FROM direct_upload_targets WHERE item_id=?').get(itemId) as
      DirectTarget | undefined) ?? null
  );
}

/** 送信前に名前と配置先を固定する。再試行時に別名へ変えて重複を作らない。 */
export async function prepareDirectTarget(
  ctx: JobContext,
  item: MigrationItem,
): Promise<DirectTarget | null> {
  const folderId = await preservedDestination(ctx, item);
  const saved = getDirectTarget(ctx.store, item.id);
  if (saved) {
    if (saved.folder_id !== folderId)
      throw new ShuttleError('BOX_CONFLICT', '転送先のフォルダーが変更されています。');
    return saved;
  }
  // OVERWRITEの既存ファイルはprepareVersionTargetが扱う。ここで新たに
  // 見つかったファイルを上書き対象へ切り替えない。
  if (
    ctx.profile.conflictPolicy === 'OVERWRITE' &&
    (await ctx.gateway.findFileByName(folderId, item.sourceFileName))
  )
    throw new ShuttleError(
      'BOX_CONFLICT',
      '確認後に同名ファイルが作成されました。確認し直してください。',
    );
  const planned = await resolveName(ctx, item, folderId, item.sourceFileName);
  if (planned.kind === 'SKIP') {
    ctx.store.transitionItem({
      itemId: item.id,
      to: 'SKIPPED',
      telemetry: ctx.telemetry,
      event: { phase: 'PREFLIGHT', status: 'SKIPPED', message: planned.reason },
    });
    return null;
  }
  ctx.store.transaction(() => {
    ctx.store.db
      .prepare('INSERT INTO direct_upload_targets (item_id,folder_id,name) VALUES (?,?,?)')
      .run(item.id, folderId, planned.name);
    ctx.store.updateItem(item.id, { finalFolderId: folderId, finalName: planned.name });
  });
  return getDirectTarget(ctx.store, item.id)!;
}

export async function beginDirectUpload(ctx: JobContext, item: MigrationItem): Promise<void> {
  const target = getDirectTarget(ctx.store, item.id);
  if (!target) throw new ShuttleError('STATE_INVALID', '転送先が記録されていません。');
  if ((await preservedDestination(ctx, item)) !== target.folder_id)
    throw new ShuttleError('BOX_CONFLICT', '転送先のフォルダーが変更されています。');
  if (await ctx.gateway.findFileByName(target.folder_id, target.name)) {
    // 同名・同じSHA-1でも、この移行が作成した証拠にはならない。
    // 不明な結果を別名転送や既存ファイルの採用で覆い隠さない。
    throw new ShuttleError(
      'BOX_CONFLICT',
      target.attempted
        ? '転送先に同名ファイルがありますが、前回の転送結果を特定できません。Boxで確認してください。重複転送は行っていません。'
        : '確認後に同名ファイルが作成されました。Boxで確認してください。',
    );
  }
  ctx.store.db.prepare('UPDATE direct_upload_targets SET attempted=1 WHERE item_id=?').run(item.id);
}
