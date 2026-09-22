import type { MetadataTemplateSpec } from './gateway';

/**
 * The single MVP template (docs/decisions.md D-008). Provenance fields plus
 * generic business fields shared by every document type. Domain specific
 * templates are explicitly out of scope.
 */
export function migrationTemplateSpec(
  scope: string,
  templateKey: string,
  destinationKeys: readonly string[],
): MetadataTemplateSpec {
  return {
    scope,
    templateKey,
    displayName: 'Shuttle Lite Migration',
    fields: [
      { key: 'migrationJobId', type: 'string', displayName: 'Migration job ID' },
      { key: 'migrationItemId', type: 'string', displayName: 'Migration item ID' },
      { key: 'sourceRelativePath', type: 'string', displayName: 'Source relative path' },
      { key: 'sourceFileName', type: 'string', displayName: 'Source file name' },
      { key: 'sourceModifiedAt', type: 'date', displayName: 'Source modified at' },
      { key: 'sourceSize', type: 'float', displayName: 'Source size (bytes)' },
      { key: 'sourceSha1', type: 'string', displayName: 'Source SHA-1' },
      { key: 'migratedAt', type: 'date', displayName: 'Migrated at' },
      {
        key: 'migrationStatus',
        type: 'enum',
        displayName: 'Migration status',
        options: ['STAGED', 'VERIFIED', 'PLACED'],
      },
      { key: 'documentType', type: 'string', displayName: 'Document type' },
      { key: 'businessDomain', type: 'string', displayName: 'Business domain' },
      { key: 'businessIdentifier', type: 'string', displayName: 'Business identifier' },
      { key: 'effectiveDate', type: 'date', displayName: 'Effective date' },
      { key: 'suggestedTags', type: 'string', displayName: 'Suggested tags' },
      {
        key: 'suggestedDestinationKey',
        type: destinationKeys.length ? 'enum' : 'string',
        displayName: 'Suggested destination key',
        ...(destinationKeys.length ? { options: [...destinationKeys] } : {}),
      },
      {
        key: 'approvedDestinationKey',
        type: destinationKeys.length ? 'enum' : 'string',
        displayName: 'Approved destination key',
        ...(destinationKeys.length ? { options: [...destinationKeys] } : {}),
      },
      { key: 'routingReason', type: 'string', displayName: 'Routing reason' },
      { key: 'approvedBy', type: 'string', displayName: 'Approved by (local operator label)' },
    ],
  };
}
