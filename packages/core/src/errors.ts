/**
 * Failure boundaries from docs/architecture.md section 13. Every failure the
 * worker records carries a category so that the UI can show a cause and a
 * recommended action instead of a bare status code.
 */

export const ERROR_CATEGORIES = [
  'SOURCE_READ',
  'SOURCE_CHANGED',
  'SOURCE_MISSING',
  'SOURCE_LOCKED',
  'PATH_TOO_LONG',
  'PROXY_CONNECT',
  'PROXY_AUTH',
  'PROXY_TLS',
  'PROXY_REQUIRED',
  'BOX_AUTH',
  'BOX_PERMISSION',
  'BOX_NOT_FOUND',
  'BOX_CONFLICT',
  'BOX_RATE_LIMIT',
  'BOX_SERVER',
  'BOX_BAD_REQUEST',
  'BOX_TIMEOUT',
  'UPLOAD_SESSION_EXPIRED',
  'UPLOAD_PART_MISMATCH',
  'INTEGRITY_MISMATCH',
  'NAME_INVALID',
  'SIZE_LIMIT',
  'METADATA_SCHEMA',
  'METADATA_CONFLICT',
  'AI_DISABLED',
  'AI_UNSUPPORTED',
  'AI_NOT_READY',
  'AI_INVALID_OUTPUT',
  'AI_FAILURE',
  'DESTINATION_UNKNOWN',
  'APPROVAL_STALE',
  'APPROVAL_INVALID',
  'MOVE_CONFLICT',
  'TELEMETRY_DELIVERY',
  'STATE_INVALID',
  'CONFIG_INVALID',
  'UNKNOWN',
] as const;

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

interface CategoryMeta {
  /** Whether the worker may retry the same step without operator input. */
  readonly retryable: boolean;
  /** Whether the outcome of the remote call is unknown and needs reconciliation. */
  readonly needsReconcile?: boolean;
  /** Whether the item should stop and wait for a human. */
  readonly needsReview?: boolean;
  /** Operator facing guidance, shown in the UI next to the failure. */
  readonly operatorAction: string;
}

export const ERROR_CATEGORY_META: Record<ErrorCategory, CategoryMeta> = {
  SOURCE_READ: {
    retryable: true,
    operatorAction: 'Source fileの読み取り権限とdiskの状態を確認してください。',
  },
  SOURCE_CHANGED: {
    retryable: false,
    needsReview: true,
    operatorAction: 'Scan後にsource fileが変更されました。再scanしてから再実行してください。',
  },
  SOURCE_MISSING: {
    retryable: false,
    needsReview: true,
    operatorAction: 'Source fileが見つかりません。移動・削除の有無を確認してください。',
  },
  SOURCE_LOCKED: {
    retryable: true,
    operatorAction:
      '他のprocessがfileを開いています。Officeで編集中か、antivirusのscan中の可能性があります。自動で再試行します。',
  },
  PATH_TOO_LONG: {
    retryable: false,
    needsReview: true,
    operatorAction:
      'Pathが長すぎます。Windowsの260文字制限に該当します。LongPathsEnabledを有効にするか、上位folderを分割してください。',
  },
  PROXY_CONNECT: {
    retryable: true,
    operatorAction: 'Proxy hostとportへの到達性を確認してください。',
  },
  PROXY_AUTH: {
    retryable: false,
    operatorAction: 'Proxyのuser名とpasswordを確認してください。407が返っています。',
  },
  PROXY_TLS: {
    retryable: false,
    operatorAction:
      'Proxyのcertificateを信頼できません。PROXY_CA_BUNDLE_PATHにCAを設定してください。TLS検証は無効化しません。',
  },
  PROXY_REQUIRED: {
    retryable: false,
    operatorAction:
      'PROXY_MODE=requiredですがproxyが利用できません。direct接続へfallbackしません。',
  },
  BOX_AUTH: {
    retryable: false,
    operatorAction: 'Box client ID、client secret、enterprise IDとscopeを確認してください。',
  },
  BOX_PERMISSION: {
    retryable: false,
    operatorAction: 'Service Accountに対象folderのupload権限が付与されているか確認してください。',
  },
  BOX_NOT_FOUND: {
    retryable: false,
    operatorAction: 'Folder IDまたはfile IDの存在を確認してください。',
  },
  BOX_CONFLICT: {
    retryable: false,
    needsReview: true,
    operatorAction: '同名itemが存在します。無断上書きせずreviewで対応を選んでください。',
  },
  BOX_RATE_LIMIT: {
    retryable: true,
    operatorAction: 'Rate limitです。Retry-Afterに従って自動で再試行します。',
  },
  BOX_SERVER: {
    retryable: true,
    needsReconcile: true,
    operatorAction: 'Box側の一時errorです。自動で再試行し、結果不明はreconcileします。',
  },
  BOX_BAD_REQUEST: {
    retryable: false,
    operatorAction: 'Requestが不正です。Request IDを添えて調査してください。',
  },
  BOX_TIMEOUT: {
    retryable: true,
    needsReconcile: true,
    operatorAction: 'Timeoutです。Box側の実際の結果を照合してから再試行します。',
  },
  UPLOAD_SESSION_EXPIRED: {
    retryable: true,
    operatorAction: 'Upload sessionが期限切れです。新しいsessionで再開します。',
  },
  UPLOAD_PART_MISMATCH: {
    retryable: true,
    operatorAction: 'Part情報が一致しません。Box側のpart一覧と照合してから再開します。',
  },
  INTEGRITY_MISMATCH: {
    retryable: false,
    needsReview: true,
    operatorAction: 'SizeまたはSHA-1が一致しません。完了扱いにしません。',
  },
  NAME_INVALID: {
    retryable: false,
    needsReview: true,
    operatorAction: 'Boxで利用できないfile名です。reviewでrenameを判断してください。',
  },
  SIZE_LIMIT: {
    retryable: false,
    needsReview: true,
    operatorAction: 'Box accountのfile size上限を超えています。',
  },
  METADATA_SCHEMA: {
    retryable: false,
    operatorAction: 'Metadata templateのkeyとfield型を確認してください。',
  },
  METADATA_CONFLICT: {
    retryable: true,
    operatorAction: '既存のmetadata instanceを読み取って同一itemか確認します。',
  },
  AI_DISABLED: {
    retryable: false,
    needsReview: true,
    operatorAction: 'AI routingが無効です。手動でdestinationとmetadataを入力してください。',
  },
  AI_UNSUPPORTED: {
    retryable: false,
    needsReview: true,
    operatorAction: 'Box AIが対象外のfile形式です。手動入力で先へ進めます。',
  },
  AI_NOT_READY: {
    retryable: true,
    operatorAction: 'Representation生成待ちです。時間をおいて再試行します。',
  },
  AI_INVALID_OUTPUT: {
    retryable: true,
    needsReview: true,
    operatorAction: 'AI出力がschemaに合いません。手動入力で先へ進めます。',
  },
  AI_FAILURE: {
    retryable: true,
    needsReview: true,
    operatorAction: 'AI呼び出しが失敗しました。上限到達後は手動入力へ切り替えます。',
  },
  DESTINATION_UNKNOWN: {
    retryable: false,
    needsReview: true,
    operatorAction: 'Catalogに存在しないdestination keyです。moveせずreviewへ送ります。',
  },
  APPROVAL_STALE: {
    retryable: false,
    needsReview: true,
    operatorAction: '承認後に対象が変わりました。再承認が必要です。',
  },
  APPROVAL_INVALID: {
    retryable: false,
    needsReview: true,
    operatorAction: '承認内容が検証に失敗しました。入力値を確認してください。',
  },
  MOVE_CONFLICT: {
    retryable: false,
    needsReview: true,
    operatorAction: 'Final folderに同名itemがあります。上書きせずreviewで判断してください。',
  },
  TELEMETRY_DELIVERY: {
    retryable: true,
    operatorAction: 'Telemetry送信の失敗です。Migrationは継続し、復旧後に再送します。',
  },
  STATE_INVALID: {
    retryable: false,
    operatorAction: '許可されないstate遷移です。bugとして調査してください。',
  },
  CONFIG_INVALID: {
    retryable: false,
    operatorAction: '設定が不正です。.envとprofileを確認してください。',
  },
  UNKNOWN: {
    retryable: false,
    needsReconcile: true,
    operatorAction: '未分類のerrorです。logとrequest IDを確認してください。',
  },
};

export interface ShuttleErrorOptions {
  readonly cause?: unknown;
  /** Honour this exact delay before the next attempt. Set from Retry-After. */
  readonly retryAfterMs?: number;
  readonly status?: number;
  readonly requestId?: string;
  readonly details?: Record<string, unknown>;
}

export class ShuttleError extends Error {
  readonly category: ErrorCategory;
  readonly retryAfterMs?: number;
  readonly status?: number;
  readonly requestId?: string;
  readonly details?: Record<string, unknown>;

  constructor(category: ErrorCategory, message: string, options: ShuttleErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ShuttleError';
    this.category = category;
    this.retryAfterMs = options.retryAfterMs;
    this.status = options.status;
    this.requestId = options.requestId;
    this.details = options.details;
  }

  get retryable(): boolean {
    return ERROR_CATEGORY_META[this.category].retryable;
  }

  get needsReview(): boolean {
    return ERROR_CATEGORY_META[this.category].needsReview === true;
  }

  get needsReconcile(): boolean {
    return ERROR_CATEGORY_META[this.category].needsReconcile === true;
  }

  get operatorAction(): string {
    return ERROR_CATEGORY_META[this.category].operatorAction;
  }

  toJSON(): Record<string, unknown> {
    return {
      category: this.category,
      message: this.message,
      status: this.status,
      requestId: this.requestId,
      retryAfterMs: this.retryAfterMs,
      details: this.details,
    };
  }
}

export function isShuttleError(value: unknown): value is ShuttleError {
  return value instanceof ShuttleError;
}

export function toShuttleError(value: unknown, fallback: ErrorCategory = 'UNKNOWN'): ShuttleError {
  if (isShuttleError(value)) return value;
  const message = value instanceof Error ? value.message : String(value);
  return new ShuttleError(fallback, message, { cause: value });
}

export function errorCategoryOf(value: unknown): ErrorCategory {
  return isShuttleError(value) ? value.category : 'UNKNOWN';
}
