import { posix } from 'node:path';
import { assertDestinationCurrent } from '@shuttle-lite/box';
import { type MigrationFolder, type MigrationItem, ShuttleError } from '@shuttle-lite/core';
import type { JobContext } from './context';

function snapshot(ctx: JobContext) {
  const selected = ctx.store.getJobDestinations(ctx.job.id);
  if (!selected) throw new ShuttleError('CONFIG_INVALID', 'Boxの移行先が未設定です。');
  return selected;
}

function validatePath(folder: MigrationFolder): void {
  const parts = folder.relativePath.split('/');
  if (
    !folder.name ||
    folder.name === '.' ||
    folder.name === '..' ||
    /[/\\\0]/.test(folder.name) ||
    (folder.relativePath !== '' && parts.some((part) => !part || part === '.' || part === '..')) ||
    (folder.relativePath === ''
      ? folder.parentPath !== null
      : folder.name !== posix.basename(folder.relativePath) ||
        folder.parentPath !==
          (posix.dirname(folder.relativePath) === '.' ? '' : posix.dirname(folder.relativePath)))
  )
    throw new ShuttleError('CONFIG_INVALID', '移行元のフォルダー構成を確認してください。');
}

/** 名前から作り直すのは未確定の行だけ。ID確定後の移動・改名は停止する。 */
export async function prepareFolderTree(
  ctx: JobContext,
  shouldYield: () => boolean,
): Promise<boolean> {
  const selected = snapshot(ctx);
  await assertDestinationCurrent(ctx.gateway, selected, selected.rootFolderId);
  const folders = ctx.store.listMigrationFolders(ctx.job.id);
  if (!folders.some((folder) => folder.relativePath === '')) {
    throw new ShuttleError('CONFIG_INVALID', '移行元のフォルダーを再スキャンしてください。');
  }
  const ids = new Map<string, string>();
  for (const folder of folders) {
    if (shouldYield()) return false;
    validatePath(folder);
    const parentId =
      folder.parentPath === null ? selected.rootFolderId : ids.get(folder.parentPath);
    if (!parentId) throw new ShuttleError('CONFIG_INVALID', '親フォルダーが未確定です。');
    const id = folder.boxFolderId ?? (await ctx.gateway.ensureFolder(parentId, folder.name)).id;
    if (
      [
        ctx.layout.stagingRootFolderId,
        ctx.layout.needsReviewFolderId,
        ctx.layout.reportsFolderId,
      ].includes(id)
    ) {
      throw new ShuttleError(
        'CONFIG_INVALID',
        '処理用フォルダーと移行元のフォルダー名が重複しています。',
      );
    }
    // 409のconflictがファイルだった場合も、folder GETで受け入れない。
    const current = await ctx.gateway.getFolder(id);
    if (!current || current.parentFolderId !== parentId || current.name !== folder.name) {
      throw new ShuttleError(
        'BOX_CONFLICT',
        `移行先のフォルダーを確認してください: ${folder.name}`,
      );
    }
    ctx.store.setMigrationFolderId(ctx.job.id, folder.relativePath, id);
    ids.set(folder.relativePath, id);
  }
  return true;
}

export async function preservedDestination(ctx: JobContext, item: MigrationItem): Promise<string> {
  const selected = snapshot(ctx);
  await assertDestinationCurrent(ctx.gateway, selected, selected.rootFolderId);
  const folders = new Map(
    ctx.store.listMigrationFolders(ctx.job.id).map((f) => [f.relativePath, f]),
  );
  let path = posix.dirname(item.sourceRelativePath);
  if (path === '.') path = '';
  const targetId = folders.get(path)?.boxFolderId;
  if (!targetId) throw new ShuttleError('CONFIG_INVALID', '配置先のフォルダーが未確定です。');
  const seen = new Set<string>();
  while (true) {
    const folder = folders.get(path);
    if (!folder?.boxFolderId || seen.has(path))
      throw new ShuttleError('CONFIG_INVALID', '配置先の階層が不正です。');
    seen.add(path);
    validatePath(folder);
    const parentId =
      folder.parentPath === null
        ? selected.rootFolderId
        : folders.get(folder.parentPath)?.boxFolderId;
    const current = await ctx.gateway.getFolder(folder.boxFolderId);
    if (!current || current.name !== folder.name || current.parentFolderId !== parentId) {
      throw new ShuttleError('BOX_CONFLICT', '配置先のフォルダーが削除・移動・改名されています。');
    }
    if (folder.parentPath === null) break;
    path = folder.parentPath;
  }
  return targetId;
}
