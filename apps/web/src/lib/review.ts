import {
  templateId,
  ERROR_CATEGORY_META,
  type ErrorCategory,
  type MigrationItem,
} from '@shuttle-lite/core';
import { hasRoutingDecision } from '@shuttle-lite/routing';
import type { ReviewItemView } from './review-types';
import { getCatalog, getStore, getConfig } from './runtime';
import { validReviewDraft, type SavedReviewDraft } from './review-drafts';

/**
 * Shared by the review page and the review API so the screen and any
 * automation see exactly the same projection.
 */
export function buildReviewViews(
  jobId: string,
  limit = 200,
  sourceItems?: readonly MigrationItem[],
): ReviewItemView[] {
  const store = getStore();
  const job = store.getJob(jobId);
  const canExtract = Boolean(
    getConfig().ai.enabled && job && store.getProfile(job.profileId)?.aiRoutingEnabled,
  );
  const { needsReviewKey } = getCatalog(jobId);
  return (
    sourceItems ?? store.listItems(jobId, { states: ['REVIEW_REQUIRED', 'NEEDS_REVIEW'], limit })
  ).map((item) => {
    const routing = store.getRouting(item.id);
    const extraction = store.latestExtraction(item.id);
    const mappings = store.getJobMetadata(jobId);
    const business = mappings ? store.getBusinessMetadata(item.id) : null;
    const command = store.latestReviewCommand(jobId, item.id);
    const hasCurrentError = item.lastErrorCategory !== null && store.hasCurrentReviewError(item.id);
    return {
      ...(business
        ? {
            businessMetadata: {
              ...business,
              canExtract,
              template:
                mappings?.find((m) => templateId(m.template) === business.templateId)?.template ??
                null,
            },
          }
        : {}),
      itemId: item.id,
      jobId,
      state: item.state,
      sourceRelativePath: item.sourceRelativePath,
      sourceFileName: item.sourceFileName,
      sourceSize: item.sourceSize,
      sourceSha1: item.sourceSha1,
      boxFileId: item.boxFileId,
      boxSha1: item.boxSha1,
      boxVersionId: item.boxFileVersionId,
      lastErrorCategory: hasCurrentError ? item.lastErrorCategory : null,
      lastError: hasCurrentError ? item.lastError : null,
      operatorAction: hasCurrentError
        ? (ERROR_CATEGORY_META[item.lastErrorCategory as ErrorCategory]?.operatorAction ?? null)
        : null,
      // 未解決の失敗だけを一括承認から外す。復旧済みの一時エラーは含めない。
      needsAttention: hasCurrentError || business?.extractionStatus === 'FAILED',
      finalName: item.finalName,
      suggestedDestinationKey: routing?.suggestedDestinationKey ?? null,
      hasRoutingDecision: hasRoutingDecision(
        routing?.suggestedDestinationKey ?? null,
        needsReviewKey,
      ),
      suggestionSource: routing?.suggestionSource ?? null,
      // Show document-specific AI evidence, not routing diagnostics or legacy manual hints.
      suggestionReason:
        routing?.suggestionSource === 'MANUAL' ? null : (extraction?.reason ?? null),
      reviewCommand: command
        ? {
            id: command.id,
            state: command.state,
            rejectionReason: command.rejectionReason,
            createdAt: command.createdAt,
          }
        : null,
      extraction: extraction
        ? {
            provider: extraction.provider,
            documentType: extraction.documentType,
            businessDomain: extraction.businessDomain,
            businessIdentifier: extraction.businessIdentifier,
            effectiveDate: extraction.effectiveDate,
            suggestedTags: extraction.suggestedTags,
            confidence: extraction.confidence,
            references: extraction.references,
          }
        : null,
    };
  });
}

export function buildReviewPage(
  jobId: string,
  requestedPage = 1,
  query = '',
  filter = 'all',
  drafts: readonly SavedReviewDraft[] = [],
) {
  const catalog = getCatalog(jobId);
  const destinationOverrides: Record<string, string> = {};
  for (const saved of drafts) {
    try {
      const observed = JSON.parse(saved.revision) as { itemId?: string };
      if (typeof observed.itemId !== 'string') continue;
      const item = getStore().getItem(observed.itemId);
      if (
        !item ||
        item.jobId !== jobId ||
        !['REVIEW_REQUIRED', 'NEEDS_REVIEW'].includes(item.state)
      )
        continue;
      const view = buildReviewViews(jobId, 1, [item])[0]!;
      if (typeof saved.draft?.destinationKey === 'string' && validReviewDraft(view, saved))
        destinationOverrides[item.id] = saved.draft.destinationKey;
    } catch {
      // A damaged browser draft must never affect the server's review projection.
    }
  }
  const page = getStore().reviewPage(jobId, requestedPage, query, {
    filter,
    destinationOverrides,
    destinationKeys: catalog.entries
      .filter((entry) => entry.key !== catalog.needsReviewKey)
      .map((entry) => entry.key),
  });
  return {
    ...page,
    destinationOverrides,
    items: buildReviewViews(jobId, page.pageSize, page.items),
  };
}
