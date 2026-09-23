import type { BoxFilePreview, BoxGateway } from '@shuttle-lite/box';
import { ShuttleError } from '@shuttle-lite/core';
import type { ShuttleStore } from '@shuttle-lite/db';

export class FilePreviewError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

interface ObservedFile {
  observedBoxFileId: string | null;
  observedBoxVersionId: string | null;
  observedBoxSha1: string | null;
}

function parseObservedFile(value: unknown): ObservedFile {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new FilePreviewError('INVALID_REQUEST', 'ファイルの指定が不正です', 400);
  const input = value as Record<string, unknown>;
  for (const field of ['observedBoxFileId', 'observedBoxVersionId', 'observedBoxSha1']) {
    if (input[field] !== null && (typeof input[field] !== 'string' || !input[field]))
      throw new FilePreviewError('INVALID_REQUEST', 'ファイルの指定が不正です', 400);
  }
  return input as unknown as ObservedFile;
}

function stale(): never {
  throw new FilePreviewError(
    'FILE_CHANGED',
    'ファイルの状態が変わりました。閉じて確認し直してください',
    409,
  );
}

/** Only accept Box's expiring preview URLs, never arbitrary frame destinations. */
export function validatePreviewUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new FilePreviewError('PREVIEW_UNAVAILABLE', 'プレビューを取得できませんでした', 502);
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !(url.hostname === 'app.box.com' || url.hostname.endsWith('.app.box.com')) ||
    !/^\/preview\/expiring_embed\/[^/]+$/.test(url.pathname)
  ) {
    throw new FilePreviewError('PREVIEW_UNAVAILABLE', 'プレビューを取得できませんでした', 502);
  }
  url.searchParams.set('showDownload', 'false');
  url.searchParams.set('showAnnotations', 'false');
  return url.toString();
}

export async function createFilePreview(
  store: Pick<ShuttleStore, 'getJob' | 'getItem'>,
  gateway: Pick<BoxGateway, 'kind' | 'getFilePreview'>,
  jobId: string,
  itemId: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<BoxFilePreview> {
  const observed = parseObservedFile(body);
  function readTarget() {
    const job = store.getJob(jobId);
    const item = store.getItem(itemId);
    if (!job || !item || item.jobId !== jobId)
      throw new FilePreviewError('NOT_FOUND', '対象ファイルが見つかりません', 404);
    if (job.cleanupState !== 'NONE')
      throw new FilePreviewError('TEST_ENDED', 'このテストは終了しています', 409);
    if (!['REVIEW_REQUIRED', 'NEEDS_REVIEW'].includes(item.state)) stale();
    if (!item.boxFileId || !item.boxFileVersionId || !item.boxSha1)
      throw new FilePreviewError('FILE_NOT_READY', 'ファイルの確認が完了していません', 409);
    if (
      observed.observedBoxFileId !== item.boxFileId ||
      observed.observedBoxVersionId !== item.boxFileVersionId ||
      observed.observedBoxSha1 !== item.boxSha1
    )
      stale();
    return item;
  }
  const item = readTarget();
  if (gateway.kind === 'fake')
    throw new FilePreviewError(
      'PREVIEW_UNAVAILABLE',
      'デモモードではプレビューを利用できません',
      409,
    );
  const preview = await gateway.getFilePreview(item.boxFileId!, signal);
  if (!preview) throw new FilePreviewError('NOT_FOUND', 'Box上に対象ファイルが見つかりません', 404);
  if (
    preview.fileId !== item.boxFileId ||
    preview.versionId !== item.boxFileVersionId ||
    preview.sha1 !== item.boxSha1
  )
    stale();
  // The worker may have moved on or cleanup may have started during the Box request.
  readTarget();
  return {
    fileId: preview.fileId,
    versionId: preview.versionId,
    sha1: preview.sha1,
    url: validatePreviewUrl(preview.url),
  };
}

/** Never return upstream messages: they can contain credentials or expiring URLs. */
export function filePreviewError(error: unknown): FilePreviewError {
  if (error instanceof FilePreviewError) return error;
  if (error instanceof ShuttleError) {
    if (error.category === 'BOX_AUTH' || error.category === 'BOX_PERMISSION')
      return new FilePreviewError('BOX_ACCESS', 'Boxの認証または閲覧権限を確認してください', 502);
    if (error.category === 'BOX_NOT_FOUND')
      return new FilePreviewError('NOT_FOUND', 'Box上に対象ファイルが見つかりません', 404);
    if (error.category === 'BOX_RATE_LIMIT')
      return new FilePreviewError(
        'RATE_LIMIT',
        'Boxが混み合っています。時間をおいて再読み込みしてください',
        429,
        Math.max(1, Math.ceil((error.retryAfterMs ?? 30_000) / 1000)),
      );
    if (error.category === 'BOX_TIMEOUT')
      return new FilePreviewError(
        'TIMEOUT',
        'プレビューの取得に時間がかかっています。再読み込みしてください',
        504,
      );
  }
  return new FilePreviewError(
    'PREVIEW_UNAVAILABLE',
    'プレビューを取得できませんでした。再読み込みするかBoxで原本を開いてください',
    502,
  );
}
