import { ShuttleError, toRfc3339, toRfc3339OrNull } from '@shuttle-lite/core';

export type MetadataValue = string | number | boolean | null;
export type MetadataRecord = Record<string, MetadataValue>;

export interface ProvenanceInput {
  readonly migrationJobId: string;
  readonly migrationItemId: string;
  readonly sourceRelativePath: string;
  readonly sourceFileName: string;
  readonly sourceModifiedAt: string;
  readonly sourceSize: number;
  readonly sourceSha1: string;
  readonly migratedAt: string;
  readonly migrationStatus: 'STAGED' | 'VERIFIED' | 'PLACED';
}

/**
 * Provenance fields from docs/requirements.md 4.8. Only the relative path is
 * sent; the absolute local path never leaves the machine.
 */
export function buildProvenanceMetadata(input: ProvenanceInput): MetadataRecord {
  if (input.sourceRelativePath.startsWith('/')) {
    throw new ShuttleError(
      'METADATA_SCHEMA',
      'sourceRelativePathに絶対pathを渡すことはできません',
      { details: { sourceRelativePath: input.sourceRelativePath } },
    );
  }
  return {
    migrationJobId: input.migrationJobId,
    migrationItemId: input.migrationItemId,
    sourceRelativePath: input.sourceRelativePath,
    sourceFileName: input.sourceFileName,
    // Boxのdate fieldはRFC 3339を要求する。
    sourceModifiedAt: toRfc3339(input.sourceModifiedAt),
    sourceSize: input.sourceSize,
    sourceSha1: input.sourceSha1,
    migratedAt: toRfc3339(input.migratedAt),
    migrationStatus: input.migrationStatus,
  };
}

export interface RoutingMetadataInput {
  readonly documentType: string | null;
  readonly businessDomain: string | null;
  readonly businessIdentifier: string | null;
  readonly effectiveDate: string | null;
  readonly suggestedTags: string | null;
  readonly suggestedDestinationKey: string | null;
  readonly approvedDestinationKey: string;
  readonly routingReason: string | null;
  readonly approvedBy: string;
}

/** Business and routing fields written after approval, before the final move. */
export function buildRoutingMetadata(input: RoutingMetadataInput): MetadataRecord {
  const record: MetadataRecord = {
    approvedDestinationKey: input.approvedDestinationKey,
    approvedBy: input.approvedBy,
    migrationStatus: 'PLACED',
  };
  const optional: Array<[string, MetadataValue]> = [
    ['documentType', input.documentType],
    ['businessDomain', input.businessDomain],
    ['businessIdentifier', input.businessIdentifier],
    // AIは `2026-04-01` のような日付のみを返す。Boxはそれを受け付けない。
    ['effectiveDate', toRfc3339OrNull(input.effectiveDate)],
    ['suggestedTags', input.suggestedTags],
    ['suggestedDestinationKey', input.suggestedDestinationKey],
    ['routingReason', input.routingReason],
  ];
  for (const [key, value] of optional) {
    // Box rejects empty enum values, and a null would overwrite a real value
    // with nothing. Absent stays absent.
    if (value !== null && value !== undefined && value !== '') record[key] = value;
  }
  return record;
}

export const REQUIRED_PROVENANCE_KEYS = [
  'migrationJobId',
  'migrationItemId',
  'sourceRelativePath',
  'sourceFileName',
  'sourceSize',
  'sourceSha1',
  'migratedAt',
  'migrationStatus',
] as const;

/**
 * Final verification: an item is not COMPLETED unless every required
 * provenance field survived the metadata write (acceptance criterion 11).
 */
export function missingProvenanceKeys(metadata: Record<string, unknown> | null): string[] {
  if (!metadata) return [...REQUIRED_PROVENANCE_KEYS];
  return REQUIRED_PROVENANCE_KEYS.filter((key) => {
    const value = metadata[key];
    return value === undefined || value === null || value === '';
  });
}
