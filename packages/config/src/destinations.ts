import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { ShuttleError } from '@shuttle-lite/core';
import { fromRepoRoot } from './paths';

export const DestinationEntrySchema = z.object({
  key: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/, 'destination keyは大文字とアンダースコアのみ使用できます'),
  label: z.string().min(1),
  boxPath: z.string().startsWith('/'),
  description: z.string().optional(),
});

export const DestinationCatalogSchema = z
  .object({
    id: z.string().min(1),
    needsReviewKey: z.string().min(1),
    entries: z.array(DestinationEntrySchema).min(1),
  })
  .refine(
    (catalog) => catalog.entries.some((entry) => entry.key === catalog.needsReviewKey),
    'needsReviewKey は entries に含まれていなければなりません',
  )
  .refine((catalog) => {
    const keys = catalog.entries.map((entry) => entry.key);
    return new Set(keys).size === keys.length;
  }, 'destination keyが重複しています');

export type DestinationEntryConfig = z.infer<typeof DestinationEntrySchema>;
export type DestinationCatalogConfig = z.infer<typeof DestinationCatalogSchema>;

export const EMPTY_DESTINATION_CATALOG: DestinationCatalogConfig = {
  id: 'unselected',
  needsReviewKey: 'NEEDS_REVIEW',
  entries: [],
};

export const DEFAULT_CATALOG_PATH = 'config/destinations.json';

/**
 * The catalog is the allowlist that keeps Box AI from inventing a folder ID
 * (docs/requirements.md 4.10). Folder IDs are resolved separately at runtime,
 * so this file stays valid before the Box objects exist.
 */
export function loadDestinationCatalog(path = DEFAULT_CATALOG_PATH): DestinationCatalogConfig {
  const absolute = fromRepoRoot(path);
  let raw: string;
  try {
    raw = readFileSync(absolute, 'utf8');
  } catch (error) {
    throw new ShuttleError('CONFIG_INVALID', `destination catalogを読み込めません: ${absolute}`, {
      cause: error,
    });
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    throw new ShuttleError(
      'CONFIG_INVALID',
      `destination catalogがJSONとして不正です: ${absolute}`,
      {
        cause: error,
      },
    );
  }
  const parsed = DestinationCatalogSchema.safeParse(parsedJson);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ShuttleError('CONFIG_INVALID', `destination catalogの検証に失敗しました\n${details}`);
  }
  return parsed.data;
}

export function destinationKeys(catalog: DestinationCatalogConfig): string[] {
  return catalog.entries.map((entry) => entry.key);
}

export function findDestination(
  catalog: DestinationCatalogConfig,
  key: string,
): DestinationEntryConfig | undefined {
  return catalog.entries.find((entry) => entry.key === key);
}
