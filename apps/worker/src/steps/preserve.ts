import { type MigrationItem, ShuttleError } from '@shuttle-lite/core';
import type { JobContext } from '../context';
import { preservedDestination } from '../folder-tree';
import { resolveName } from './placement';

export async function readyForPreservedPlacement(
  ctx: JobContext,
  item: MigrationItem,
): Promise<void> {
  ctx.store.transitionItem({
    itemId: item.id,
    to: 'APPROVED',
    telemetry: ctx.telemetry,
    event: { phase: 'TRANSFER_VERIFY', status: 'SUCCEEDED', message: '指定された階層へ配置します' },
  });
}

/** 開始時の配置指示を使う。AIの提案や個別の承認recordは生成しない。 */
export async function placePreservedItem(ctx: JobContext, item: MigrationItem): Promise<void> {
  if (!item.boxFileId || !item.sourceSha1 || !item.transferVerifiedAt) {
    throw new ShuttleError('STATE_INVALID', '転送検証が完了していません。');
  }
  const targetId = await preservedDestination(ctx, item);
  const file = await ctx.gateway.getFile(item.boxFileId);
  if (!file) throw new ShuttleError('BOX_NOT_FOUND', '移行中のファイルが見つかりません。');
  if (file.size !== item.sourceSize || file.sha1 !== item.sourceSha1) {
    throw new ShuttleError('INTEGRITY_MISMATCH', '転送後のファイルの内容が変わっています。');
  }
  // move成功後に応答・ローカル更新を失った場合は、同じIDと配置予定を照合する。
  if (
    item.finalFolderId === targetId &&
    file.parentFolderId === targetId &&
    file.name === item.finalName
  ) {
    await verifyPreservedItem(ctx, item);
    return;
  }
  if (file.parentFolderId !== ctx.stagingFolderId || file.versionId !== item.boxFileVersionId) {
    throw new ShuttleError('BOX_CONFLICT', '転送後のファイルが変更・移動されています。');
  }
  let requestedName = item.finalName ?? item.sourceFileName;
  for (let attempt = 0; attempt <= 20; attempt += 1) {
    const planned = await resolveName(ctx, { ...item, finalName: null }, targetId, requestedName);
    if (planned.kind === 'SKIP') {
      ctx.store.transitionItem({
        itemId: item.id,
        to: 'SKIPPED',
        telemetry: ctx.telemetry,
        patch: { lastErrorCategory: 'MOVE_CONFLICT', lastError: planned.reason },
        event: { phase: 'MOVE', status: 'SKIPPED', boxFileId: file.id, message: planned.reason },
      });
      return;
    }
    // 遠隔操作より先に意図を保存する。再起動後にmoveを重複実行しないための根拠。
    ctx.store.transitionItem({
      itemId: item.id,
      to: 'MOVING',
      telemetry: ctx.telemetry,
      patch: { finalFolderId: targetId, finalName: planned.name },
      event: { phase: 'MOVE', status: 'STARTED', boxFileId: file.id },
    });
    try {
      const moved = await ctx.gateway.moveFile({
        fileId: file.id,
        targetFolderId: targetId,
        newName: planned.name,
      });
      ctx.store.transitionItem({
        itemId: item.id,
        to: 'FINAL_VERIFY',
        telemetry: ctx.telemetry,
        patch: { boxFileVersionId: moved.versionId },
        event: { phase: 'MOVE', status: 'SUCCEEDED', boxFileId: file.id },
      });
      return;
    } catch (error) {
      if (
        !(error instanceof ShuttleError) ||
        !['MOVE_CONFLICT', 'BOX_CONFLICT'].includes(error.category) ||
        attempt === 20
      )
        throw error;
      requestedName = planned.name;
    }
  }
}

export async function verifyPreservedItem(ctx: JobContext, item: MigrationItem): Promise<void> {
  const targetId = await preservedDestination(ctx, item);
  const file = item.boxFileId ? await ctx.gateway.getFile(item.boxFileId) : null;
  if (!file) throw new ShuttleError('BOX_NOT_FOUND', '最終検証でファイルが見つかりません。');
  if (
    file.parentFolderId !== targetId ||
    file.name !== item.finalName ||
    item.finalFolderId !== targetId
  ) {
    throw new ShuttleError('MOVE_CONFLICT', 'ファイルが指定された配置先にありません。');
  }
  if (file.size !== item.sourceSize || file.sha1 !== item.sourceSha1) {
    throw new ShuttleError('INTEGRITY_MISMATCH', '最終検証でサイズまたはSHA-1が一致しません。');
  }
  if (ctx.store.getItem(item.id)?.state !== 'FINAL_VERIFY') {
    ctx.store.transitionItem({ itemId: item.id, to: 'FINAL_VERIFY', telemetry: ctx.telemetry });
  }
  ctx.store.transitionItem({
    itemId: item.id,
    to: 'COMPLETED',
    telemetry: ctx.telemetry,
    patch: {
      completedAt: new Date().toISOString(),
      boxFileVersionId: file.versionId,
      lastError: null,
      lastErrorCategory: null,
      nextAttemptAt: null,
    },
    event: { phase: 'FINAL_VERIFY', status: 'SUCCEEDED', boxFileId: file.id, sizeBytes: file.size },
  });
}
