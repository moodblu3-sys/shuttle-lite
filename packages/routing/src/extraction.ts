import { z } from 'zod';
import { ShuttleError } from '@shuttle-lite/core';

export const ExtractionAnswerSchema = z.looseObject({
  documentType: z.string().nullish(),
  businessDomain: z.string().nullish(),
  businessIdentifier: z.string().nullish(),
  effectiveDate: z.string().nullish(),
  suggestedDestinationKey: z.string().nullish(),
  suggestedTags: z.union([z.string(), z.array(z.string())]).nullish(),
  reason: z.string().nullish(),
});

export interface NormalizedExtraction {
  readonly documentType: string | null;
  readonly businessDomain: string | null;
  readonly businessIdentifier: string | null;
  readonly effectiveDate: string | null;
  readonly suggestedDestinationKey: string | null;
  /** Set when the model returned a key that is not in the catalog. */
  readonly rejectedDestinationKey: string | null;
  readonly suggestedTags: readonly string[];
  readonly reason: string | null;
  readonly confidence: number | null;
  readonly references: readonly string[];
  readonly provider: string;
  readonly rawFields: Record<string, unknown>;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

function normalizeDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = ISO_DATE.exec(value.trim());
  if (!match) return null;
  const iso = `${match[1]}-${match[2]}-${match[3]}`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

function normalizeTags(value: string | string[] | null | undefined): string[] {
  const list = Array.isArray(value) ? value : (value ?? '').split(',');
  const cleaned = list.map((tag) => tag.trim()).filter((tag) => tag.length > 0 && tag.length <= 40);
  return [...new Set(cleaned)].slice(0, 10);
}

function clean(value: string | null | undefined, maxLength = 255): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.toLowerCase() === 'null') return null;
  return trimmed.slice(0, maxLength);
}

export interface ExtractionSource {
  readonly provider: string;
  readonly fields: Record<string, unknown>;
  readonly confidence: number | null;
  readonly references: readonly string[];
}

/**
 * Turns a provider answer into values the application will act on. A
 * destination key outside the catalog is recorded but never used, which is
 * what keeps the AI from choosing an arbitrary folder
 * (docs/decisions.md D-007).
 */
export function normalizeExtraction(
  source: ExtractionSource,
  allowedKeys: readonly string[],
): NormalizedExtraction {
  const parsed = ExtractionAnswerSchema.safeParse(source.fields);
  if (!parsed.success) {
    throw new ShuttleError('AI_INVALID_OUTPUT', 'AI出力がschemaに一致しません', {
      details: {
        issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      },
    });
  }
  const answer = parsed.data;
  const rawKey = clean(answer.suggestedDestinationKey, 64);
  const upperKey = rawKey ? rawKey.toUpperCase().replace(/[\s-]+/g, '_') : null;
  const accepted = upperKey && allowedKeys.includes(upperKey) ? upperKey : null;

  return {
    documentType: clean(answer.documentType, 120),
    businessDomain: clean(answer.businessDomain, 60),
    businessIdentifier: clean(answer.businessIdentifier, 120),
    effectiveDate: normalizeDate(answer.effectiveDate),
    suggestedDestinationKey: accepted,
    rejectedDestinationKey: accepted === null ? upperKey : null,
    suggestedTags: normalizeTags(answer.suggestedTags),
    reason: clean(answer.reason, 500),
    // Confidence is stored only when the provider supplies it, and it is not
    // treated as the probability that the destination is correct (4.9).
    confidence:
      typeof source.confidence === 'number' && Number.isFinite(source.confidence)
        ? source.confidence
        : null,
    references: source.references.slice(0, 5),
    provider: source.provider,
    rawFields: source.fields,
  };
}

export type RoutingOutcome =
  | { readonly kind: 'SUGGESTED'; readonly destinationKey: string; readonly reason: string | null }
  | { readonly kind: 'NEEDS_INPUT'; readonly reason: string };

/**
 * Even a confident suggestion only reaches the review queue. Nothing is moved
 * without a human decision in the MVP (docs/requirements.md 4.11).
 */
export function routingOutcome(extraction: NormalizedExtraction): RoutingOutcome {
  if (extraction.rejectedDestinationKey) {
    return {
      kind: 'NEEDS_INPUT',
      reason: `catalogに存在しないdestination keyが返されました: ${extraction.rejectedDestinationKey}`,
    };
  }
  if (!extraction.suggestedDestinationKey) {
    return {
      kind: 'NEEDS_INPUT',
      reason: extraction.reason ?? 'AIがdestinationを提案できませんでした',
    };
  }
  return {
    kind: 'SUGGESTED',
    destinationKey: extraction.suggestedDestinationKey,
    reason: extraction.reason,
  };
}
