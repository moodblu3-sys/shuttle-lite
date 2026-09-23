import { applyBusinessMetadata, verifyBusinessMetadata } from '../business-metadata';
import {
  assertDestinationCurrent,
  compatibleRoutingMetadata,
  destinationRoutingEvidence,
  type BoxGateway,
  destinationFolderId,
} from '@shuttle-lite/box';
import { type MigrationItem, ShuttleError, withNameSuffix } from '@shuttle-lite/core';
import {
  buildRoutingMetadata,
  checkApprovalFreshness,
  missingProvenanceKeys,
} from '@shuttle-lite/routing';
import { destinationKeys, type JobContext } from '../context';

/**
 * APPROVED: re-check the approval against the current Box state, write the
 * routing metadata, then move inside Box. The file ID is preserved; nothing is
 * re-uploaded (docs/decisions.md D-006).
 */
export async function placeItem(ctx: JobContext, item: MigrationItem): Promise<void> {
  const routing = ctx.store.getRouting(item.id);
  if (
    !routing ||
    routing.state !== 'APPROVED' ||
    !routing.approvedDestinationKey ||
    !routing.approvedBoxFileId ||
    !routing.approvedSha1 ||
    !routing.approvedAt ||
    !routing.operatorLabel
  ) {
    throw new ShuttleError('APPROVAL_INVALID', '有効な承認recordがないままmoveに進んでいます');
  }
  if (!item.boxFileId) {
    throw new ShuttleError('STATE_INVALID', 'Box file IDがないままmoveに進んでいます');
  }

  const current = await ctx.gateway.getFile(item.boxFileId);
  const freshness = checkApprovalFreshness(
    {
      approvedDestinationKey: routing.approvedDestinationKey,
      approvedBoxFileId: routing.approvedBoxFileId,
      approvedBoxVersionId: routing.approvedBoxVersionId,
      approvedSha1: routing.approvedSha1,
      operatorLabel: routing.operatorLabel,
      approvedAt: routing.approvedAt,
    },
    current
      ? {
          fileId: current.id,
          sha1: current.sha1,
          versionId: current.versionId,
          parentFolderId: current.parentFolderId,
        }
      : null,
    { expectedStagingFolderId: ctx.stagingFolderId, allowedKeys: destinationKeys(ctx) },
  );

  if (!freshness.fresh) {
    ctx.store.setRoutingState(item.id, 'STALE');
    ctx.store.transitionItem({
      itemId: item.id,
      to: 'REVIEW_REQUIRED',
      telemetry: ctx.telemetry,
      patch: { lastErrorCategory: 'APPROVAL_STALE', lastError: freshness.reason },
      event: {
        status: 'FAILED',
        phase: 'MOVE',
        errorCategory: 'APPROVAL_STALE',
        boxFileId: item.boxFileId,
        message: `再承認が必要です: ${freshness.reason}`,
      },
    });
    return;
  }

  const targetFolderId = destinationFolderId(ctx.layout, routing.approvedDestinationKey);
  const destinations = ctx.store.getJobDestinations(item.jobId);
  if (destinations) await assertDestinationCurrent(ctx.gateway, destinations, targetFolderId);
  if (ctx.store.getJobMetadata(item.jobId) !== null) {
    await applyBusinessMetadata(ctx, item);
  } else {
    const extraction = ctx.store.latestExtraction(item.id);
    const approved = (routing.approvedMetadata ?? {}) as Record<string, string | null | undefined>;

    let metadata = buildRoutingMetadata({
      documentType: approved.documentType ?? extraction?.documentType ?? null,
      businessDomain: approved.businessDomain ?? extraction?.businessDomain ?? null,
      businessIdentifier: approved.businessIdentifier ?? extraction?.businessIdentifier ?? null,
      effectiveDate: approved.effectiveDate ?? extraction?.effectiveDate ?? null,
      suggestedTags: approved.suggestedTags ?? extraction?.suggestedTags.join(',') ?? null,
      suggestedDestinationKey: routing.suggestedDestinationKey,
      approvedDestinationKey: routing.approvedDestinationKey,
      routingReason: approved.routingReason ?? routing.suggestionReason ?? null,
      approvedBy: routing.operatorLabel,
    });
    if (destinations) {
      const target = destinations.entries.find((entry) => entry.folderId === targetFolderId)!;
      metadata = {
        ...metadata,
        routingReason: `${metadata.routingReason ?? ''} ${destinationRoutingEvidence(target)}`,
      };
      metadata = compatibleRoutingMetadata(metadata, await ctx.gateway.getMetadataTemplate());
    }
    await ctx.gateway.updateMetadata(item.boxFileId, metadata);
  }

  // The original name is restored only at final placement; staging used the
  // deterministic name so that recovery could find it. 同名衝突を操作者が
  // 改名で解消した場合だけ、承認時に指定された名前を使う。
  const requestedName = item.finalName ?? item.sourceFileName;
  const skip = (reason: string, from: 'APPROVED' | 'MOVING') => {
    ctx.store.transitionItem({
      itemId: item.id,
      to: 'SKIPPED',
      expectedFrom: from,
      telemetry: ctx.telemetry,
      patch: { lastErrorCategory: 'MOVE_CONFLICT', lastError: reason },
      event: {
        status: 'SKIPPED',
        phase: 'MOVE',
        boxFileId: item.boxFileId,
        destinationKey: routing.approvedDestinationKey,
        message: reason,
      },
    });
  };

  const planned = await resolveName(ctx, item, targetFolderId, requestedName);
  if (planned.kind === 'SKIP') {
    skip(planned.reason, 'APPROVED');
    return;
  }

  ctx.store.transitionItem({
    itemId: item.id,
    to: 'MOVING',
    telemetry: ctx.telemetry,
    event: {
      status: 'STARTED',
      phase: 'MOVE',
      boxFileId: item.boxFileId,
      destinationKey: routing.approvedDestinationKey,
      humanOverride: routing.humanOverride,
      message:
        planned.name === item.sourceFileName
          ? null
          : `同名衝突のため改名して配置します: ${item.sourceFileName} → ${planned.name}`,
    },
  });

  // 名前を確かめてから動かすまでの間に、別のitemが同じ名前を取ることがある。
  // Boxが返す衝突をもう一度policyに通すまでが「衝突の解決」。
  let name = planned.name;
  let moved: Awaited<ReturnType<BoxGateway['moveFile']>> | null = null;
  for (let attempt = 0; moved === null; attempt += 1) {
    try {
      moved = await ctx.gateway.moveFile({
        fileId: item.boxFileId,
        targetFolderId,
        newName: name,
      });
    } catch (cause) {
      if (!isConflict(cause) || attempt >= RENAME_ATTEMPTS) throw cause;
      const retry = await resolveName(ctx, item, targetFolderId, name);
      if (retry.kind === 'SKIP') {
        skip(retry.reason, 'MOVING');
        return;
      }
      name = retry.name;
    }
  }

  ctx.store.transitionItem({
    itemId: item.id,
    to: 'FINAL_VERIFY',
    telemetry: ctx.telemetry,
    patch: {
      finalFolderId: moved.parentFolderId,
      finalName: moved.name,
      boxFileVersionId: moved.versionId,
    },
    event: {
      status: 'SUCCEEDED',
      phase: 'MOVE',
      boxFileId: moved.id,
      destinationKey: routing.approvedDestinationKey,
      humanOverride: routing.humanOverride,
    },
  });
}

/**
 * Our own pre-check reports MOVE_CONFLICT; Box reports a taken name as a 409,
 * which maps to BOX_CONFLICT. Both mean the same thing here.
 */
function isConflict(cause: unknown): boolean {
  return (
    cause instanceof ShuttleError &&
    (cause.category === 'MOVE_CONFLICT' || cause.category === 'BOX_CONFLICT')
  );
}

type NameResolution =
  | { readonly kind: 'MOVE'; readonly name: string }
  | { readonly kind: 'SKIP'; readonly reason: string };

/** How many suffixed names to try before giving up and asking a human. */
const RENAME_ATTEMPTS = 20;

/**
 * Box Shuttle never overwrites a name that is already taken: it appends a
 * unique suffix, or skips the file for a later delta sync. The job's
 * conflictPolicy picks between those two (docs/decisions.md D-017).
 *
 * A name the operator typed is exempt. They decided it while looking at the
 * conflict, so changing it silently would replace their judgement.
 */
async function resolveName(
  ctx: JobContext,
  item: MigrationItem,
  targetFolderId: string,
  requestedName: string,
): Promise<NameResolution> {
  const taken = await ctx.gateway.findFileByName(targetFolderId, requestedName);
  if (!taken) return { kind: 'MOVE', name: requestedName };

  if (item.finalName !== null) {
    throw new ShuttleError('MOVE_CONFLICT', `移動先に同名itemがあります: ${requestedName}`, {
      details: { conflictFileId: taken.id, targetFolderId },
    });
  }
  if (ctx.profile.conflictPolicy === 'SKIP') {
    return {
      kind: 'SKIP',
      reason: `移動先に同名itemがあるためskipしました: ${requestedName}`,
    };
  }

  let candidate = requestedName;
  for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt += 1) {
    candidate = withNameSuffix(candidate);
    if (!(await ctx.gateway.findFileByName(targetFolderId, candidate))) {
      return { kind: 'MOVE', name: candidate };
    }
  }
  throw new ShuttleError(
    'MOVE_CONFLICT',
    `改名しても空きが見つかりませんでした: ${requestedName} (${RENAME_ATTEMPTS}回試行)`,
    { details: { targetFolderId } },
  );
}

/**
 * FINAL_VERIFY: the only path to COMPLETED. Destination, content and required
 * metadata are all re-read from Box (acceptance criterion 11).
 */
export async function finalVerify(ctx: JobContext, item: MigrationItem): Promise<void> {
  const routing = ctx.store.getRouting(item.id);
  if (!item.boxFileId || !routing?.approvedDestinationKey) {
    throw new ShuttleError('STATE_INVALID', '最終検証に必要な情報が不足しています');
  }
  const expectedFolderId = destinationFolderId(ctx.layout, routing.approvedDestinationKey);
  const file = await ctx.gateway.getFile(item.boxFileId);
  if (!file) {
    throw new ShuttleError('BOX_NOT_FOUND', `最終検証でfileが見つかりません: ${item.boxFileId}`);
  }
  if (file.parentFolderId !== expectedFolderId) {
    throw new ShuttleError('MOVE_CONFLICT', 'file が想定のfinal folderにありません', {
      details: { expectedFolderId, actualFolderId: file.parentFolderId },
    });
  }
  if (file.size !== item.sourceSize || file.sha1 !== item.sourceSha1) {
    throw new ShuttleError('INTEGRITY_MISMATCH', '最終検証でsizeまたはSHA-1が一致しません', {
      details: { boxSize: file.size, boxSha1: file.sha1 },
    });
  }
  if (ctx.store.getJobMetadata(item.jobId) !== null) {
    await verifyBusinessMetadata(ctx, item);
  } else {
    const metadata = await ctx.gateway.getMetadata(item.boxFileId);
    const missing = missingProvenanceKeys(metadata);
    if (missing.length > 0) {
      throw new ShuttleError(
        'METADATA_SCHEMA',
        `必須provenance metadataが不足しています: ${missing.join(', ')}`,
      );
    }
    let destinationRecorded = metadata?.approvedDestinationKey === routing.approvedDestinationKey;
    const destinations = ctx.store.getJobDestinations(item.jobId);
    if (!destinationRecorded && destinations) {
      const template = await ctx.gateway.getMetadataTemplate();
      const field = template?.fields.find((entry) => entry.key === 'approvedDestinationKey');
      const target = destinations.entries.find(
        (entry) => entry.key === routing.approvedDestinationKey,
      );
      // A legacy fixed enum cannot store a new key. Verify the exact evidence
      // written to the existing string field, plus the actual folder ID above.
      destinationRecorded = Boolean(
        target &&
        field?.type === 'enum' &&
        !field.options?.includes(routing.approvedDestinationKey) &&
        typeof metadata?.routingReason === 'string' &&
        metadata.routingReason.endsWith(destinationRoutingEvidence(target)) &&
        metadata.approvedBy === routing.operatorLabel,
      );
    }
    if (!destinationRecorded) {
      throw new ShuttleError(
        'METADATA_SCHEMA',
        'approvedDestinationKeyがmetadataに反映されていません',
        {
          details: {
            expected: routing.approvedDestinationKey,
            actual: metadata?.approvedDestinationKey,
          },
        },
      );
    }
  }

  ctx.store.transitionItem({
    itemId: item.id,
    to: 'COMPLETED',
    telemetry: ctx.telemetry,
    patch: {
      finalFolderId: file.parentFolderId,
      finalName: file.name,
      completedAt: new Date().toISOString(),
      lastError: null,
      lastErrorCategory: null,
    },
    event: {
      status: 'SUCCEEDED',
      phase: 'FINAL_VERIFY',
      boxFileId: file.id,
      sizeBytes: file.size,
      destinationKey: routing.approvedDestinationKey,
      humanOverride: routing.humanOverride,
    },
  });
}
