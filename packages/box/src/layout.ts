import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AppConfig, DestinationCatalogConfig } from '@shuttle-lite/config';
import { ShuttleError } from '@shuttle-lite/core';
import type { BoxGateway } from './gateway';

export const LAYOUT_ROOT_NAME = 'Shuttle Lite';
export const STAGING_FOLDER_NAME = '_staging';
export const NEEDS_REVIEW_FOLDER_NAME = '_needs_review';
export const REPORTS_FOLDER_NAME = '_reports';

export interface BoxLayout {
  readonly rootFolderId: string;
  readonly stagingRootFolderId: string;
  readonly needsReviewFolderId: string;
  readonly reportsFolderId: string;
  /** destination key to Box folder ID. The AI never sees these values. */
  readonly destinations: Record<string, string>;
  readonly resolvedAt: string;
  readonly mode: 'fake' | 'real';
}

export function layoutPath(config: AppConfig): string {
  return join(config.dataDir, 'box-layout.json');
}

/**
 * Cacheは、それを作ったときと同じ設定でしか使えない。`BOX_ROOT_FOLDER_ID` を
 * 別のfolderへ向け直したのにcacheを再利用すると、意図しない場所へ移行して
 * しまうため、rootが変わっていたら破棄する。
 */
export function loadCachedLayout(config: AppConfig): BoxLayout | null {
  const path = layoutPath(config);
  if (!existsSync(path)) return null;
  try {
    const layout = JSON.parse(readFileSync(path, 'utf8')) as BoxLayout;
    if (layout.mode !== config.box.mode) return null;
    if (config.box.rootFolderId && layout.rootFolderId !== config.box.rootFolderId) return null;
    // 明示指定されたfolder IDとcacheが食い違う場合も作り直す。
    if (config.box.stagingFolderId && layout.stagingRootFolderId !== config.box.stagingFolderId) {
      return null;
    }
    return config.box.mode === 'real' ? { ...layout, destinations: {} } : layout;
  } catch {
    return null;
  }
}

export function saveLayout(config: AppConfig, layout: BoxLayout): void {
  const path = layoutPath(config);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(layout, null, 2)}\n`);
}

/** Segments below the Shuttle Lite root, e.g. "/Shuttle Lite/destinations/Legal/Contracts". */
export function segmentsUnderRoot(boxPath: string): string[] {
  const segments = boxPath.split('/').filter((segment) => segment.trim().length > 0);
  if (segments[0] === LAYOUT_ROOT_NAME) return segments.slice(1);
  return segments;
}

/**
 * Creates (or finds) the folder layout from docs/architecture.md section 12.
 * Idempotent, so it is safe to run on every worker start and from the
 * bootstrap script.
 */
export async function ensureBoxLayout(
  gateway: BoxGateway,
  config: AppConfig,
  catalog: DestinationCatalogConfig,
): Promise<BoxLayout> {
  const base = config.box.rootFolderId ?? '0';
  const root =
    config.box.mode === 'real' && config.box.rootFolderId
      ? await gateway.getFolder(base)
      : await gateway.ensureFolderPath(base, [LAYOUT_ROOT_NAME]);
  if (!root) {
    throw new ShuttleError('BOX_NOT_FOUND', `root folderが見つかりません: ${base}`);
  }

  const staging =
    config.box.stagingFolderId ?? (await gateway.ensureFolder(root.id, STAGING_FOLDER_NAME)).id;
  const needsReview =
    config.box.needsReviewFolderId ??
    (await gateway.ensureFolder(root.id, NEEDS_REVIEW_FOLDER_NAME)).id;
  const reports =
    config.box.reportsFolderId ?? (await gateway.ensureFolder(root.id, REPORTS_FOLDER_NAME)).id;

  const destinations: Record<string, string> = {};
  for (const entry of config.box.mode === 'fake' ? catalog.entries : []) {
    const segments = segmentsUnderRoot(entry.boxPath);
    if (segments.length === 0) {
      destinations[entry.key] = root.id;
      continue;
    }
    if (segments.length === 1 && segments[0] === NEEDS_REVIEW_FOLDER_NAME) {
      destinations[entry.key] = needsReview;
      continue;
    }
    const folder = await gateway.ensureFolderPath(root.id, segments);
    destinations[entry.key] = folder.id;
  }

  const layout: BoxLayout = {
    rootFolderId: root.id,
    stagingRootFolderId: staging,
    needsReviewFolderId: needsReview,
    reportsFolderId: reports,
    destinations,
    resolvedAt: new Date().toISOString(),
    mode: config.box.mode,
  };
  saveLayout(config, layout);
  return layout;
}

/** Each job gets its own staging folder so access can be scoped per migration. */
export async function ensureJobStagingFolder(
  gateway: BoxGateway,
  layout: BoxLayout,
  jobId: string,
): Promise<string> {
  const folder = await gateway.ensureFolder(layout.stagingRootFolderId, jobId);
  return folder.id;
}

export function destinationFolderId(layout: BoxLayout, key: string): string {
  const id = layout.destinations[key];
  if (!id) {
    throw new ShuttleError('DESTINATION_UNKNOWN', `catalogに存在しないdestination keyです: ${key}`);
  }
  return id;
}
