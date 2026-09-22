import { migrationItemId, type MigrationItem, ShuttleError } from '@shuttle-lite/core';
import type { JobContext } from '../context';
import type { SourceItemInfo, SourceRef } from '../source/adapter';

export function sourceRefOf(item: MigrationItem): SourceRef {
  return {
    relativePath: item.sourceRelativePath,
    locator: item.sourceAbsolutePath,
    size: item.sourceSize,
    modifiedAt: item.sourceModifiedAt,
  };
}

/**
 * The source is read only and may change under us. Every step that is about to
 * act on content re-checks it first (docs/requirements.md 4.4, 4.7).
 */
export async function assertSourceUnchanged(
  ctx: JobContext,
  item: MigrationItem,
): Promise<SourceItemInfo> {
  const current = await ctx.source.stat(sourceRefOf(item));
  if (current.size !== item.sourceSize || current.modifiedAt !== item.sourceModifiedAt) {
    throw new ShuttleError(
      'SOURCE_CHANGED',
      'Scan時からsource fileが変更されています。再scanしてから再実行してください。',
      {
        details: {
          scannedSize: item.sourceSize,
          currentSize: current.size,
          scannedModifiedAt: item.sourceModifiedAt,
          currentModifiedAt: current.modifiedAt,
        },
      },
    );
  }
  return current;
}

export interface ScanSummary {
  readonly inserted: number;
  readonly unchanged: number;
  readonly rescanned: number;
  readonly totalBytes: number;
}

/**
 * Walks whatever the source adapter exposes and records one migration item per
 * file. Writing an item is idempotent, so a rescan never redoes finished work.
 */
export async function scanSource(ctx: JobContext): Promise<ScanSummary> {
  await ctx.source.verifyRoot();
  let inserted = 0;
  let unchanged = 0;
  let rescanned = 0;
  let totalBytes = 0;

  for await (const entry of ctx.source.scan()) {
    const outcome = ctx.store.upsertScannedItem({
      id: migrationItemId(ctx.job.id, entry.relativePath),
      jobId: ctx.job.id,
      sourceRelativePath: entry.relativePath,
      sourceAbsolutePath: entry.locator,
      sourceFileName: entry.fileName,
      sourceSize: entry.size,
      sourceModifiedAt: entry.modifiedAt,
      sourceInode: entry.externalId,
      fileType: entry.fileType,
    });
    totalBytes += entry.size;
    if (outcome === 'INSERTED') inserted += 1;
    else if (outcome === 'RESCANNED') rescanned += 1;
    else unchanged += 1;
  }

  ctx.store.refreshJobTotals(ctx.job.id);
  return { inserted, unchanged, rescanned, totalBytes };
}
