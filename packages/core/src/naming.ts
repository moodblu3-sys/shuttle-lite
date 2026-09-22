import { ShuttleError } from './errors';

const BOX_FORBIDDEN = /[\\/:*?"<>|]/g;
const BOX_FORBIDDEN_TEST = /[\\/:*?"<>|]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_TEST = /[\u0000-\u001f\u007f]/;
const MAX_NAME_BYTES = 255;
export const STAGING_SEPARATOR = '__';

function truncateToBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let out = value;
  while (Buffer.byteLength(out, 'utf8') > maxBytes && out.length > 0) {
    out = out.slice(0, -1);
  }
  return out;
}

/** Split "report.final.pdf" into ["report.final", ".pdf"]. */
export function splitExtension(name: string): [string, string] {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return [name, ''];
  return [name.slice(0, dot), name.slice(dot)];
}

function cleanNameCharacters(name: string): string {
  const cleaned = name
    .replace(CONTROL_CHARS, '_')
    .replace(BOX_FORBIDDEN, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/, '');
  return cleaned.length > 0 ? cleaned : 'unnamed';
}

/** Truncate the stem so that the extension survives, which preview and AI both rely on. */
function truncatePreservingExtension(name: string, maxBytes: number): string {
  if (Buffer.byteLength(name, 'utf8') <= maxBytes) return name;
  const [stem, ext] = splitExtension(name);
  const extBytes = Buffer.byteLength(ext, 'utf8');
  if (extBytes >= maxBytes) return truncateToBytes(name, maxBytes);
  return `${truncateToBytes(stem, maxBytes - extBytes)}${ext}`;
}

export function sanitizeFileName(name: string): string {
  return truncatePreservingExtension(cleanNameCharacters(name), MAX_NAME_BYTES);
}

/**
 * "report.pdf" -> "report (2).pdf" -> "report (3).pdf". Used both by the
 * RENAME conflict policy and by the review screen, so the operator sees the
 * same shape of name the worker would have produced.
 */
export function withNameSuffix(name: string, counter?: number): string {
  const [stem, ext] = splitExtension(name);
  const match = /^(.*) \((\d+)\)$/.exec(stem);
  const base = match ? (match[1] as string) : stem;
  const next = counter ?? (match ? Number(match[2]) + 1 : 2);
  return truncatePreservingExtension(`${base} (${next})${ext}`, MAX_NAME_BYTES);
}

export interface NameCheck {
  readonly valid: boolean;
  readonly reason?: string;
}

/**
 * Names Box rejects outright. Used by preflight so that an unusable name
 * becomes a classified review item instead of a mid-upload failure.
 */
export function checkBoxFileName(name: string): NameCheck {
  if (name.length === 0) return { valid: false, reason: 'file名が空です' };
  if (name === '.' || name === '..')
    return { valid: false, reason: '. および .. は使用できません' };
  if (BOX_FORBIDDEN_TEST.test(name)) {
    return { valid: false, reason: '\\ / : * ? " < > | は使用できません' };
  }
  if (CONTROL_CHARS_TEST.test(name)) {
    return { valid: false, reason: '制御文字は使用できません' };
  }
  if (name !== name.trim()) return { valid: false, reason: '先頭または末尾の空白は使用できません' };
  if (name.endsWith('.')) return { valid: false, reason: '末尾のピリオドは使用できません' };
  if (Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) {
    return { valid: false, reason: `file名が${MAX_NAME_BYTES} byteを超えています` };
  }
  return { valid: true };
}

export function assertBoxFileName(name: string): void {
  const check = checkBoxFileName(name);
  if (!check.valid) {
    throw new ShuttleError('NAME_INVALID', `Boxで利用できないfile名です: ${check.reason}`, {
      details: { name },
    });
  }
}

/**
 * Deterministic staging name from docs/architecture.md section 4.2. The item
 * ID prefix lets the worker find an upload whose outcome is unknown by listing
 * the staging folder, without relying on Search indexing.
 */
export function stagingFileName(migrationItemId: string, originalName: string): string {
  const prefix = `${migrationItemId}${STAGING_SEPARATOR}`;
  const budget = Math.max(1, MAX_NAME_BYTES - Buffer.byteLength(prefix, 'utf8'));
  return `${prefix}${truncatePreservingExtension(cleanNameCharacters(originalName), budget)}`;
}

/**
 * The classic Windows path limit. File server trees routinely exceed it, and
 * hitting it mid-upload is much worse than catching it in preflight.
 */
export const WINDOWS_MAX_PATH = 260;

const WINDOWS_RESERVED = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

/**
 * Reserved device names cannot exist on Windows, but a file can arrive from a
 * Linux or NAS share over SMB with such a name.
 */
export function isWindowsReservedName(name: string): boolean {
  const [stem] = splitExtension(name);
  return WINDOWS_RESERVED.has(stem.trim().toUpperCase());
}

/** Office writes `~$document.docx` lock files next to open documents. */
export function isOfficeLockFile(name: string): boolean {
  return name.startsWith('~$');
}

export function isTooLongForWindows(absolutePath: string, limit = WINDOWS_MAX_PATH): boolean {
  return absolutePath.length >= limit;
}

/** UNC (`\\server\share`) paths and mounted volumes must not host SQLite WAL. */
export function looksLikeNetworkPath(path: string): boolean {
  if (path.startsWith('\\\\') || path.startsWith('//')) return true;
  return /^\/Volumes\//.test(path);
}

const SYNC_FOLDER_PATTERNS: readonly RegExp[] = [
  /[\\/]Dropbox[\\/]/i,
  /[\\/]OneDrive[^\\/]*[\\/]/i,
  /[\\/]Google Drive[\\/]/i,
  /[\\/]Library[\\/]Mobile Documents[\\/]/,
  /[\\/]Box[\\/]/,
  /[\\/]Box Sync[\\/]/i,
];

/**
 * A sync client rewriting the file underneath SQLite corrupts WAL just as
 * reliably as a network share does (docs/requirements.md section 6).
 */
export function looksLikeSyncFolder(path: string): boolean {
  return SYNC_FOLDER_PATTERNS.some((pattern) => pattern.test(path));
}

export function unsafeStatePathReason(path: string): string | null {
  if (looksLikeNetworkPath(path)) {
    return 'ネットワーク共有またはmount volume上にあります';
  }
  if (looksLikeSyncFolder(path)) {
    return 'file同期folder (Dropbox / OneDrive / Google Drive / iCloud / Box Drive) の中にあります';
  }
  return null;
}

export function parseStagingFileName(
  name: string,
): { itemId: string; originalName: string } | null {
  const index = name.indexOf(STAGING_SEPARATOR);
  if (index <= 0) return null;
  const itemId = name.slice(0, index);
  if (!/^it_[0-9a-f]{24}$/.test(itemId)) return null;
  return { itemId, originalName: name.slice(index + STAGING_SEPARATOR.length) };
}
