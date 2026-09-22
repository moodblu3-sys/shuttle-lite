import { parseStagingFileName, stagingFileName } from '@shuttle-lite/core';
import type { JobContext } from './context';

export interface ReconcileSummary {
  readonly inspected: number;
  readonly adopted: number;
  readonly restarted: number;
}

/**
 * Startup recovery. Items whose upload outcome is unknown, or that were
 * mid-upload when the process died, are resolved by listing the staging folder
 * directly. Search is not used because it is not immediately consistent
 * (docs/architecture.md 4.2, acceptance criteria 4 and 5).
 */
export async function reconcileJob(ctx: JobContext): Promise<ReconcileSummary> {
  // Only upload outcomes are reconciled here. An unknown outcome in a later
  // phase, such as a metadata write, is simply resumed by the pipeline.
  const candidates = ctx.store
    .listItems(ctx.job.id, { states: ['UNKNOWN_OUTCOME', 'UPLOADING'], limit: 1_000 })
    .filter(
      (item) =>
        item.state === 'UPLOADING' ||
        item.resumeState === 'UPLOADING' ||
        item.resumeState === 'READY',
    );
  if (candidates.length === 0) return { inspected: 0, adopted: 0, restarted: 0 };

  const staged = await ctx.gateway.listFolder(ctx.stagingFolderId);
  const byStagingName = new Map(
    staged.filter((entry) => entry.type === 'file').map((entry) => [entry.name, entry] as const),
  );
  const byItemId = new Map(
    [...byStagingName.values()].flatMap((entry) => {
      const parsed = parseStagingFileName(entry.name);
      return parsed ? [[parsed.itemId, entry] as const] : [];
    }),
  );

  let adopted = 0;
  let restarted = 0;

  for (const item of candidates) {
    const expectedName = item.stagingName ?? stagingFileName(item.id, item.sourceFileName);
    const found = byStagingName.get(expectedName) ?? byItemId.get(item.id);

    if (found && found.sha1 && found.sha1 === item.sourceSha1) {
      // Box already has the content. Adopting it is what prevents a duplicate
      // when the process died after the upload but before the SQLite write.
      const file = await ctx.gateway.getFile(found.id);
      ctx.store.transitionItem({
        itemId: item.id,
        to: 'STAGED',
        telemetry: ctx.telemetry,
        patch: {
          stagingName: expectedName,
          boxFileId: found.id,
          boxFileVersionId: file?.versionId ?? null,
          boxSize: found.size ?? file?.size ?? null,
          boxSha1: found.sha1,
          bytesTransferred: found.size ?? item.sourceSize,
          resumeState: null,
          nextAttemptAt: null,
          lastError: null,
          lastErrorCategory: null,
        },
        event: {
          status: 'SUCCEEDED',
          phase: 'UPLOAD',
          boxFileId: found.id,
          sizeBytes: found.size ?? item.sourceSize,
          message: 'Box側のstaging fileと照合して重複なく復旧しました',
        },
      });
      adopted += 1;
      continue;
    }

    if (found && found.sha1 && found.sha1 !== item.sourceSha1) {
      ctx.logger.warn('staging上のfileがsourceと一致しないためreviewへ送ります', {
        itemId: item.id,
        boxFileId: found.id,
      });
      ctx.store.upsertSuggestion({
        itemId: item.id,
        suggestedDestinationKey: null,
        suggestionSource: 'FALLBACK',
        suggestionReason:
          'staging folderに同名で内容の異なるfileがあります。上書きせず判断が必要です。',
        state: 'NEEDS_INPUT',
      });
      ctx.store.transitionItem({
        itemId: item.id,
        to: 'NEEDS_REVIEW',
        telemetry: ctx.telemetry,
        patch: { lastErrorCategory: 'BOX_CONFLICT', lastError: 'staging上のfileが一致しません' },
        event: { status: 'FAILED', phase: 'UPLOAD', errorCategory: 'BOX_CONFLICT' },
      });
      continue;
    }

    // Nothing arrived. Rewind to PREFLIGHT so the whole check runs again.
    const openSession = ctx.store.getOpenSession(item.id);
    if (openSession) {
      const remote = await ctx.gateway.getUploadSession(openSession.boxSessionId);
      if (!remote) ctx.store.setSessionState(openSession.id, 'EXPIRED');
    }
    ctx.store.transitionItem({
      itemId: item.id,
      to: 'PREFLIGHT',
      telemetry: ctx.telemetry,
      patch: {
        resumeState: null,
        nextAttemptAt: null,
        bytesTransferred: 0,
      },
      event: {
        status: 'RETRYING',
        phase: 'UPLOAD',
        message: 'Box側にfileが無かったのでpreflightから再開します',
      },
    });
    restarted += 1;
  }

  return { inspected: candidates.length, adopted, restarted };
}
