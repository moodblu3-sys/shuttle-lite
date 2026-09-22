import { ShuttleError } from './errors';

/**
 * Boxへ渡す日時をRFC 3339へ正規化する。実Boxで次の2つを踏んだため必要になった。
 *
 * - upload attributesの `content_modified_at` は `toISOString()` のミリ秒付きを
 *   `not a valid rfc 3339 formatted date` として400で拒否する
 * - metadataのdate fieldは `2026-04-01` のような日付のみの値を
 *   `invalid value for template field` として400で拒否する
 *
 * 秒精度へ落とし、日付のみの値は00:00:00 UTCとして補完する。
 * 例: 2026-09-13T15:24:30.063Z -> 2026-09-13T15:24:30+00:00
 *     2026-04-01               -> 2026-04-01T00:00:00+00:00
 */
export function toRfc3339(value: string): string {
  const trimmed = value.trim();
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00:00Z` : trimmed;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    throw new ShuttleError('METADATA_SCHEMA', `日時として解釈できません: ${value}`, {
      details: { value },
    });
  }
  return `${date.toISOString().replace(/\.\d+Z$/, '')}+00:00`;
}

/** 値が空でなければRFC 3339へ正規化する。 */
export function toRfc3339OrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  return toRfc3339(value);
}
