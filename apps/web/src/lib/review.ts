import {
  templateId,
  ERROR_CATEGORY_META,
  type ErrorCategory,
  type MigrationItem,
} from '@shuttle-lite/core';
import { hasRoutingDecision } from '@shuttle-lite/routing';
import type { ReviewItemView } from './review-types';
import { getCatalog, getStore, getConfig } from './runtime';

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
      lastErrorCategory: item.lastErrorCategory,
      lastError: item.lastError,
      operatorAction: item.lastErrorCategory
        ? (ERROR_CATEGORY_META[item.lastErrorCategory as ErrorCategory]?.operatorAction ?? null)
        : null,
      // 前の試行が失敗して戻ってきたitem。同じ承認をもう一度送っても同じ
      // 失敗になるため、一括承認の対象から外して個別対応させる。
      needsAttention: item.lastErrorCategory !== null || business?.extractionStatus === 'FAILED',
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

export function buildReviewPage(jobId: string, requestedPage = 1, query = '') {
  const page = getStore().reviewPage(jobId, requestedPage, query);
  return { ...page, items: buildReviewViews(jobId, page.pageSize, page.items) };
}
