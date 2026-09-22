import type { DestinationOption, ReviewItemView } from './review-types';

export interface ApprovalDraft {
  readonly destinationKey: string;
  readonly finalName: string;
  readonly documentType: string;
  readonly businessDomain: string;
  readonly businessIdentifier: string;
  readonly effectiveDate: string;
  readonly suggestedTags: string;
  readonly routingReason: string;
}

export function draftFor(item: ReviewItemView): ApprovalDraft {
  return {
    // No suggestion means no preselected destination. Defaulting to the first
    // catalog entry would invite an accidental wrong placement.
    destinationKey: item.hasRoutingDecision ? (item.suggestedDestinationKey as string) : '',
    finalName: item.finalName ?? item.sourceFileName,
    documentType: item.extraction?.documentType ?? '',
    businessDomain: item.extraction?.businessDomain ?? '',
    businessIdentifier: item.extraction?.businessIdentifier ?? '',
    effectiveDate: item.extraction?.effectiveDate ?? '',
    suggestedTags: item.extraction?.suggestedTags.join(',') ?? '',
    routingReason: item.suggestionReason ?? '',
  };
}

export function commandFor(item: ReviewItemView, draft: ApprovalDraft, operatorLabel: string) {
  const text = (value: string) => (value.trim().length > 0 ? value.trim() : null);
  return {
    type: 'APPROVE_ITEM' as const,
    payload: {
      itemId: item.itemId,
      destinationKey: draft.destinationKey,
      operatorLabel,
      observedBoxFileId: item.boxFileId,
      observedSha1: item.boxSha1,
      observedVersionId: item.boxVersionId,
      // sourceのfile名どおりに置くなら指示は送らない。
      finalName:
        draft.finalName.trim() === item.sourceFileName ? null : (text(draft.finalName) ?? null),
      metadata: {
        documentType: text(draft.documentType),
        businessDomain: text(draft.businessDomain),
        businessIdentifier: text(draft.businessIdentifier),
        effectiveDate: text(draft.effectiveDate),
        suggestedTags: text(draft.suggestedTags),
        routingReason: text(draft.routingReason),
      },
    },
  };
}

/** Browser-only projection. Unresolved/failed items require individual review. */
export function groupReviewItems(
  items: readonly ReviewItemView[],
  destinations: readonly DestinationOption[],
  needsReviewKey: string,
) {
  const groups = destinations
    .filter((destination) => destination.key !== needsReviewKey)
    .map((destination) => ({
      destination,
      items: items.filter(
        (item) =>
          item.hasRoutingDecision &&
          !item.needsAttention &&
          item.suggestedDestinationKey === destination.key,
      ),
    }))
    .filter((group) => group.items.length > 0);
  const grouped = new Set(groups.flatMap((group) => group.items.map((item) => item.itemId)));
  return {
    groups,
    attention: items.filter((item) => item.needsAttention),
    undecided: items.filter((item) => !item.needsAttention && !grouped.has(item.itemId)),
  };
}

export function canApprove(
  draft: ApprovalDraft,
  destinations: readonly DestinationOption[],
  needsReviewKey: string,
) {
  return (
    draft.destinationKey !== needsReviewKey &&
    destinations.some((entry) => entry.key === draft.destinationKey)
  );
}

export function bulkReviewItems(
  items: readonly ReviewItemView[],
  selected: ReadonlySet<string>,
  draft: (item: ReviewItemView) => ApprovalDraft,
  destinations: readonly DestinationOption[],
  needsReviewKey: string,
) {
  const { groups } = groupReviewItems(items, destinations, needsReviewKey);
  return groups
    .flatMap((group) => group.items)
    .filter(
      (item) => selected.has(item.itemId) && canApprove(draft(item), destinations, needsReviewKey),
    );
}

export function matchesReviewSearch(item: ReviewItemView, query: string) {
  const normalized = query.trim().normalize('NFKC').toLocaleLowerCase('ja');
  return [item.sourceFileName, item.sourceRelativePath, item.suggestionReason ?? ''].some((value) =>
    value.normalize('NFKC').toLocaleLowerCase('ja').includes(normalized),
  );
}
