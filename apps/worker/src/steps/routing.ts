import { type MigrationItem, ShuttleError } from '@shuttle-lite/core';
import { normalizeExtraction, routingOutcome } from '@shuttle-lite/routing';
import { destinationKeys, type JobContext } from '../context';

/**
 * PROVENANCE_APPLIED and AI_PENDING. Runs on its own queue so that waiting for
 * a document representation never blocks another file's transfer
 * (docs/requirements.md 4.13).
 */
export async function runRouting(ctx: JobContext, item: MigrationItem): Promise<void> {
  if (!ctx.aiEnabled) {
    ctx.store.upsertSuggestion({
      itemId: item.id,
      suggestedDestinationKey: null,
      suggestionSource: 'MANUAL',
      suggestionReason: null,
      state: 'NEEDS_INPUT',
    });
    ctx.store.transitionItem({
      itemId: item.id,
      to: 'REVIEW_REQUIRED',
      telemetry: ctx.telemetry,
      event: {
        status: 'SKIPPED',
        phase: 'AI_EXTRACTION',
        errorCategory: 'AI_DISABLED',
        boxFileId: item.boxFileId,
        message: 'AI routingが無効です',
      },
    });
    return;
  }

  if (!item.boxFileId) {
    throw new ShuttleError('STATE_INVALID', 'Box file IDがないままAI routingに進んでいます');
  }

  if (item.state === 'PROVENANCE_APPLIED') {
    ctx.store.transitionItem({
      itemId: item.id,
      to: 'AI_PENDING',
      telemetry: ctx.telemetry,
      event: { status: 'STARTED', phase: 'AI_EXTRACTION', aiUsed: true, boxFileId: item.boxFileId },
    });
  }

  const started = Date.now();
  const allowed = [...new Set([...destinationKeys(ctx), ctx.catalog.needsReviewKey])];
  const response = await ctx.gateway.extractStructured({
    fileId: item.boxFileId,
    destinationKeys: allowed,
    destinations: ctx.catalog.entries,
    fileName: item.sourceFileName,
  });
  const extraction = normalizeExtraction(response, allowed);
  const attempt = ctx.store.countExtractionAttempts(item.id) + 1;
  ctx.store.insertExtraction({
    itemId: item.id,
    attempt,
    provider: extraction.provider,
    rawFields: extraction.rawFields,
    documentType: extraction.documentType,
    businessDomain: extraction.businessDomain,
    businessIdentifier: extraction.businessIdentifier,
    effectiveDate: extraction.effectiveDate,
    suggestedDestinationKey: extraction.suggestedDestinationKey,
    suggestedTags: extraction.suggestedTags,
    reason: extraction.reason,
    confidence: extraction.confidence,
    references: extraction.references,
  });

  const outcome =
    extraction.suggestedDestinationKey === ctx.catalog.needsReviewKey
      ? {
          kind: 'NEEDS_INPUT' as const,
          reason: extraction.reason ?? '配置先を判断できませんでした。',
        }
      : routingOutcome(extraction);
  ctx.store.upsertSuggestion({
    itemId: item.id,
    suggestedDestinationKey: outcome.kind === 'SUGGESTED' ? outcome.destinationKey : null,
    suggestionSource: 'AI',
    suggestionReason: outcome.kind === 'SUGGESTED' ? outcome.reason : outcome.reason,
    state: outcome.kind === 'SUGGESTED' ? 'SUGGESTED' : 'NEEDS_INPUT',
  });

  ctx.store.transitionItem({
    itemId: item.id,
    to: 'AI_COMPLETED',
    telemetry: ctx.telemetry,
    event: {
      status: 'SUCCEEDED',
      phase: 'AI_EXTRACTION',
      aiUsed: true,
      boxFileId: item.boxFileId,
      durationMs: Date.now() - started,
      destinationKey: outcome.kind === 'SUGGESTED' ? outcome.destinationKey : null,
    },
  });

  // A suggestion is never enough on its own: every item waits for a human.
  ctx.store.transitionItem({
    itemId: item.id,
    to: 'REVIEW_REQUIRED',
    telemetry: ctx.telemetry,
    event: {
      status: 'STARTED',
      phase: 'REVIEW',
      aiUsed: true,
      boxFileId: item.boxFileId,
      destinationKey: outcome.kind === 'SUGGESTED' ? outcome.destinationKey : null,
    },
  });
}
