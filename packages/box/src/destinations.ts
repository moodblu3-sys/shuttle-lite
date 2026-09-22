import { createHash } from 'node:crypto';
import type { AppConfig, DestinationCatalogConfig } from '@shuttle-lite/config';
import { type JobDestinations, ShuttleError } from '@shuttle-lite/core';
import type { BoxFolder, BoxGateway, MetadataTemplateSpec, MetadataValues } from './gateway';
import { loadCachedLayout } from './layout';

const MAX_FOLDERS = 200;
const MAX_DEPTH = 20;
const INTERNAL_NAMES = new Set(['_staging', '_needs_review', '_reports']);

export function validFolderId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function internalFolder(folder: BoxFolder, excluded: readonly string[]): boolean {
  return INTERNAL_NAMES.has(folder.name) || excluded.includes(folder.id);
}

export function excludedDestinationIds(config: AppConfig): string[] {
  const layout = loadCachedLayout(config);
  return [
    config.box.stagingFolderId,
    config.box.needsReviewFolderId,
    config.box.reportsFolderId,
    layout?.stagingRootFolderId,
    layout?.needsReviewFolderId,
    layout?.reportsFolderId,
  ].filter((id): id is string => Boolean(id));
}

/** Read only, including ancestry checks: selecting never creates anything in Box. */
export async function browseDestinationFolder(
  gateway: BoxGateway,
  folderId: string,
  excluded: readonly string[] = [],
): Promise<{ folder: BoxFolder; folders: BoxFolder[] }> {
  if (!validFolderId(folderId))
    throw new ShuttleError('CONFIG_INVALID', 'Boxフォルダーの指定が不正です。');
  const folder = await gateway.getFolder(folderId);
  if (!folder)
    throw new ShuttleError('BOX_NOT_FOUND', 'Boxフォルダーが見つかりません。選び直してください。');
  // Box exposes ancestry on an accessible folder. Do not require separate
  // read access to every ancestor of a collaboratively shared folder.
  if (
    folder.ancestors &&
    [folder, ...folder.ancestors].some(
      (entry) => INTERNAL_NAMES.has(entry.name) || excluded.includes(entry.id),
    )
  ) {
    throw new ShuttleError('CONFIG_INVALID', '一時保管先・処理用フォルダーは移行先に選べません。');
  }
  let current: BoxFolder | null = folder.ancestors ? null : folder;
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current.id) || seen.size >= 100 || internalFolder(current, excluded)) {
      throw new ShuttleError(
        'CONFIG_INVALID',
        '一時保管先・処理用フォルダーは移行先に選べません。',
      );
    }
    seen.add(current.id);
    if (!current.parentFolderId) break;
    current = await gateway.getFolder(current.parentFolderId);
    if (!current) throw new ShuttleError('BOX_NOT_FOUND', '親フォルダーを確認できません。');
  }
  const folders = (await gateway.listFolder(folderId))
    .filter(
      (entry) =>
        entry.type === 'folder' && !INTERNAL_NAMES.has(entry.name) && !excluded.includes(entry.id),
    )
    .map((entry) => ({ id: entry.id, name: entry.name, parentFolderId: folder.id }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  return { folder, folders };
}

/** Freeze the complete selected subtree. Never silently accept a partial listing. */
export async function collectJobDestinations(
  gateway: BoxGateway,
  rootFolderId: string,
  mode: 'fake' | 'real',
  excluded: readonly string[] = [],
): Promise<JobDestinations> {
  if (rootFolderId === '0')
    throw new ShuttleError('CONFIG_INVALID', '移行先には部署や案件のフォルダーを選んでください。');
  const { folder: root } = await browseDestinationFolder(gateway, rootFolderId, excluded);
  const entries: JobDestinations['entries'][number][] = [];
  const queue = [{ folder: root, path: '/' + root.name, depth: 0 }];
  const seen = new Set<string>();
  for (let index = 0; index < queue.length; index += 1) {
    const next = queue[index]!;
    const { folder, path, depth } = next;
    if (seen.has(folder.id))
      throw new ShuttleError(
        'CONFIG_INVALID',
        'フォルダー構成が変わりました。選び直してください。',
      );
    seen.add(folder.id);
    if (entries.length >= MAX_FOLDERS || depth > MAX_DEPTH) {
      throw new ShuttleError(
        'CONFIG_INVALID',
        '移行先の範囲が広すぎます。200フォルダー・20階層以内の範囲を選んでください。',
      );
    }
    entries.push({
      key:
        'DEST_' + createHash('sha256').update(folder.id).digest('hex').slice(0, 24).toUpperCase(),
      folderId: folder.id,
      parentFolderId: folder.parentFolderId,
      label: path.slice(1),
      boxPath: path,
      description: '選択したBoxフォルダー内の既存フォルダー',
    });
    for (const child of await gateway.listFolder(folder.id)) {
      if (child.type !== 'folder' || INTERNAL_NAMES.has(child.name) || excluded.includes(child.id))
        continue;
      if (queue.length >= MAX_FOLDERS)
        throw new ShuttleError(
          'CONFIG_INVALID',
          '移行先の範囲が広すぎます。200フォルダー以内の範囲を選んでください。',
        );
      const current = await gateway.getFolder(child.id);
      if (!current || current.parentFolderId !== folder.id) {
        throw new ShuttleError(
          'CONFIG_INVALID',
          'フォルダー構成が変わりました。選び直してください。',
        );
      }
      queue.push({ folder: current, path: path + '/' + current.name, depth: depth + 1 });
    }
  }
  return {
    mode,
    rootFolderId: root.id,
    rootFolderName: root.name,
    capturedAt: new Date().toISOString(),
    entries,
  };
}

export function catalogFromDestinations(snapshot: JobDestinations): DestinationCatalogConfig {
  return {
    id: 'job:' + snapshot.rootFolderId,
    needsReviewKey: 'NEEDS_REVIEW',
    entries: snapshot.entries.map(({ key, label, boxPath, description }) => ({
      key,
      label,
      boxPath,
      description,
    })),
  };
}

/** A folder moved outside the approved tree must not receive a file. */
export async function assertDestinationCurrent(
  gateway: BoxGateway,
  snapshot: JobDestinations,
  folderId: string,
): Promise<void> {
  const byId = new Map(snapshot.entries.map((entry) => [entry.folderId, entry]));
  let id: string | null = folderId;
  for (let depth = 0; id && depth <= MAX_DEPTH; depth += 1) {
    const expected = byId.get(id);
    const current = await gateway.getFolder(id);
    if (
      !expected ||
      !current ||
      (id !== snapshot.rootFolderId && current.parentFolderId !== expected.parentFolderId)
    )
      break;
    if (id === snapshot.rootFolderId) {
      if (current.name === snapshot.rootFolderName) return;
      break;
    }
    const parent = current.parentFolderId ? byId.get(current.parentFolderId) : undefined;
    if (!parent || expected.boxPath !== parent.boxPath + '/' + current.name) break;
    id = current.parentFolderId;
  }
  throw new ShuttleError(
    'APPROVAL_STALE',
    '配置先が削除・移動・改名されています。Boxのフォルダー構成を確認してください。',
  );
}

export function destinationRoutingEvidence(entry: JobDestinations['entries'][number]): string {
  return `配置先: ${entry.boxPath} [${entry.key}]`;
}

/** Old demo templates have fixed enums. Keep the full decision in SQLite/report,
 * and the selected path in routingReason, without modifying enterprise templates. */
export function compatibleRoutingMetadata(
  values: MetadataValues,
  template: MetadataTemplateSpec | null,
): MetadataValues {
  const result = { ...values };
  for (const key of ['suggestedDestinationKey', 'approvedDestinationKey']) {
    const field = template?.fields.find((entry) => entry.key === key);
    if (field?.type === 'enum' && !field.options?.includes(String(result[key]))) delete result[key];
  }
  return result;
}
