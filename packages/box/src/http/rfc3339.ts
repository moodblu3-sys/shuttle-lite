import { toRfc3339 } from '@shuttle-lite/core';

/**
 * Boxのupload attributes（`content_created_at` / `content_modified_at`）向けの
 * 日時書式。実体は core の {@link toRfc3339}。
 */
export function toBoxRfc3339(value: string): string {
  return toRfc3339(value);
}
