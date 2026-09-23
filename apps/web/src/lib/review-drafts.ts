import { draftFor, reviewRevision, type ApprovalDraft } from './review-model';
import type { ReviewItemView } from './review-types';

export interface SavedReviewDraft {
  revision: string;
  commandId: string | null;
  draft: ApprovalDraft;
  savedAt: number;
}

const prefix = 'shuttle:review-draft:v1:';
const maxAge = 7 * 24 * 60 * 60 * 1000;
const keyFor = (item: ReviewItemView) =>
  `${prefix}${encodeURIComponent(item.jobId)}:${encodeURIComponent(item.itemId)}`;

/** Only changed destinations are needed for a read-only, full-job filter query. */
export function destinationDrafts(storage: Storage, jobId: string): SavedReviewDraft[] {
  const drafts: SavedReviewDraft[] = [];
  const jobPrefix = `${prefix}${encodeURIComponent(jobId)}:`;
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key?.startsWith(jobPrefix)) continue;
    try {
      const saved = JSON.parse(storage.getItem(key)!) as SavedReviewDraft;
      const item = JSON.parse(saved.revision) as ReviewItemView;
      if (
        item.jobId === jobId &&
        validReviewDraft(item, saved) &&
        typeof saved.draft?.destinationKey === 'string' &&
        saved.draft.destinationKey !== draftFor(item).destinationKey
      ) {
        drafts.push({
          ...saved,
          draft: { ...draftFor(item), destinationKey: saved.draft.destinationKey },
        });
      }
    } catch {
      // Ignore malformed or unrelated browser data.
    }
  }
  return drafts;
}

export function validReviewDraft(item: ReviewItemView, saved?: SavedReviewDraft): boolean {
  return (
    !!saved &&
    saved.revision === reviewRevision(item) &&
    Date.now() - saved.savedAt < maxAge &&
    !(item.reviewCommand?.state === 'DONE' && item.reviewCommand.id !== saved.commandId)
  );
}

export function loadReviewDraft(
  storage: Storage,
  item: ReviewItemView,
): SavedReviewDraft | undefined {
  const key = keyFor(item);
  const raw = storage.getItem(key);
  if (!raw) return;
  try {
    const saved = JSON.parse(raw) as SavedReviewDraft;
    const defaults = draftFor(item);
    const values = saved?.draft?.businessValues;
    if (
      validReviewDraft(item, saved) &&
      Object.keys(defaults)
        .filter((key) => key !== 'businessValues')
        .every((key) => typeof saved.draft[key as keyof ApprovalDraft] === 'string') &&
      (values === undefined ||
        (values &&
          typeof values === 'object' &&
          !Array.isArray(values) &&
          Object.values(values).every(
            (value) =>
              typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)),
          )))
    )
      return saved;
  } catch {
    // Invalid or outdated local data is never sent as an approval.
  }
  storage.removeItem(key);
}

export function saveReviewDraft(
  storage: Storage,
  item: ReviewItemView,
  draft: ApprovalDraft,
): SavedReviewDraft {
  const saved = {
    revision: reviewRevision(item),
    commandId: item.reviewCommand?.id ?? null,
    draft,
    savedAt: Date.now(),
  };
  storage.setItem(keyFor(item), JSON.stringify(saved));
  return saved;
}
