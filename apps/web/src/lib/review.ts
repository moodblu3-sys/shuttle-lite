import { ERROR_CATEGORY_META, type ErrorCategory } from '@shuttle-lite/core';
import { hasRoutingDecision } from '@shuttle-lite/routing';
import type { ReviewItemView } from './review-types';
import { getCatalog, getStore } from './runtime';

/**
 * Shared by the review page and the review API so the screen and any
 * automation see exactly the same projection.
 */
export function buildReviewViews(jobId: string, limit = 200): ReviewItemView[] {
  const store = getStore();
  const { needsReviewKey } = getCatalog(jobId);
  return store
    .listItems(jobId, { states: ['REVIEW_REQUIRED', 'NEEDS_REVIEW'], limit })
    .map((item) => {
      const routing = store.getRouting(item.id);
      const extraction = store.latestExtraction(item.id);
      const command = store.latestReviewCommand(jobId, item.id);
      return {
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
        needsAttention: item.lastErrorCategory !== null,
        finalName: item.finalName,
        suggestedDestinationKey: routing?.suggestedDestinationKey ?? null,
        hasRoutingDecision: hasRoutingDecision(
          routing?.suggestedDestinationKey ?? null,
          needsReviewKey,
        ),
        suggestionSource: routing?.suggestionSource ?? null,
        suggestionReason: routing?.suggestionReason ?? null,
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
