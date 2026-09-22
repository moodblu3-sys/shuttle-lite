import { parseRetryAfter, ShuttleError, type ErrorCategory } from '@shuttle-lite/core';

export interface BoxErrorBody {
  readonly code?: string;
  readonly message?: string;
  readonly request_id?: string;
  readonly context_info?: {
    readonly conflicts?: unknown;
    readonly errors?: unknown;
  };
}

function categoryForStatus(status: number, code: string | undefined): ErrorCategory {
  if (status === 400 && (code === 'bad_digest' || code === 'invalid_content_md5')) {
    return 'INTEGRITY_MISMATCH';
  }
  if (status === 400) return 'BOX_BAD_REQUEST';
  if (status === 401) return 'BOX_AUTH';
  if (status === 403) {
    return code === 'storage_limit_exceeded' ? 'SIZE_LIMIT' : 'BOX_PERMISSION';
  }
  if (status === 404) return 'BOX_NOT_FOUND';
  if (status === 405) return 'BOX_BAD_REQUEST';
  if (status === 409) return 'BOX_CONFLICT';
  if (status === 410) return 'UPLOAD_SESSION_EXPIRED';
  if (status === 412) return 'UPLOAD_PART_MISMATCH';
  if (status === 413) return 'SIZE_LIMIT';
  if (status === 429) return 'BOX_RATE_LIMIT';
  if (status === 407) return 'PROXY_AUTH';
  if (status >= 500) return 'BOX_SERVER';
  return 'UNKNOWN';
}

export function requestIdOf(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const value = headers['box-request-id'] ?? headers['x-box-request-id'] ?? headers['x-request-id'];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Turns a Box HTTP failure into a classified error. The request ID is kept so
 * a failure can be taken to Box support without exposing file content.
 */
export function mapResponseError(
  status: number,
  headers: Record<string, string | string[] | undefined>,
  bodyText: string,
  context: Record<string, unknown> = {},
): ShuttleError {
  let body: BoxErrorBody;
  try {
    body = JSON.parse(bodyText) as BoxErrorBody;
  } catch {
    // A non-JSON body usually means a proxy or gateway answered, not Box.
    body = { message: bodyText.slice(0, 500) };
  }
  const retryAfterHeader = headers['retry-after'];
  const retryAfter = parseRetryAfter(
    Array.isArray(retryAfterHeader) ? retryAfterHeader[0] : retryAfterHeader,
  );
  const category = categoryForStatus(status, body.code);
  const requestId = body.request_id ?? requestIdOf(headers);
  return new ShuttleError(
    category,
    `Box API ${status} ${body.code ?? ''} ${body.message ?? ''}`.trim(),
    {
      status,
      requestId,
      retryAfterMs: retryAfter,
      details: { ...context, code: body.code, conflicts: body.context_info?.conflicts },
    },
  );
}

const TLS_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/**
 * Network level failures. The proxy categories exist so that an operator can
 * tell "the proxy refused us" from "Box refused us".
 */
/**
 * undiciはCONNECTの失敗を RequestAbortedError で返し、statusはmessageにしか
 * 入らない。Squidでの検証時、407が UNKNOWN に落ちて「proxyが拒否した」ことが
 * 読み取れなかったため、messageからstatusを取り出す。
 */
const TUNNEL_STATUS = /Proxy response \((\d{3})\) !== 200 when HTTP Tunneling/;

function tunnelFailure(error: unknown, url: string): ShuttleError | undefined {
  const message = error instanceof Error ? error.message : '';
  const status = Number(TUNNEL_STATUS.exec(message)?.[1]);
  if (!status) return undefined;
  const details = { url, proxyStatus: status };
  if (status === 407) {
    return new ShuttleError('PROXY_AUTH', 'Proxyが認証を要求しました (407)', {
      cause: error,
      details,
    });
  }
  if (status === 403 || status === 401) {
    return new ShuttleError(
      'PROXY_CONNECT',
      `Proxyが接続先への接続を拒否しました (${status})。宛先allowlistを確認してください。`,
      { cause: error, details },
    );
  }
  return new ShuttleError('PROXY_CONNECT', `ProxyのCONNECTが失敗しました (${status})`, {
    cause: error,
    details,
  });
}

export function mapTransportError(error: unknown, viaProxy: boolean, url: string): ShuttleError {
  const err = error as NodeJS.ErrnoException & { cause?: NodeJS.ErrnoException };
  const code = err.code ?? err.cause?.code ?? '';
  const target = viaProxy ? 'proxy' : 'Box';
  const tunnel = tunnelFailure(error, url);
  if (tunnel) return tunnel;
  // undiciはproxyへのTLS失敗を専用errorにする。Box自身のTLS失敗と区別する。
  if (code === 'UND_ERR_PRX_TLS') {
    return new ShuttleError('PROXY_TLS', 'ProxyとのTLS接続を確立できません', {
      cause: error,
      details: { url },
    });
  }
  if (TLS_CODES.has(code)) {
    return new ShuttleError('PROXY_TLS', `TLS certificateを検証できません (${code})`, {
      cause: error,
      details: { url },
    });
  }
  if (
    code === 'ECONNREFUSED' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH' ||
    code === 'ENOTFOUND'
  ) {
    return new ShuttleError('PROXY_CONNECT', `${target}へ接続できません (${code})`, {
      cause: error,
      details: { url },
    });
  }
  if (
    // 実Boxへの長時間uploadで ERR_HTTP2_STREAM_ERROR が発生した。いずれも
    // 一時的で結果が不明なため、reconcileしてから再試行する対象にする。
    code === 'ERR_HTTP2_STREAM_ERROR' ||
    code === 'ERR_HTTP2_GOAWAY_SESSION' ||
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === 'UND_ERR_SOCKET' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT' ||
    code === 'ETIMEDOUT'
  ) {
    return new ShuttleError('BOX_TIMEOUT', `${target}への通信がtimeoutしました (${code})`, {
      cause: error,
      details: { url },
    });
  }
  if (code === 'UND_ERR_ABORTED' || code === 'ABORT_ERR') {
    return new ShuttleError('BOX_TIMEOUT', '通信が中断されました', {
      cause: error,
      details: { url },
    });
  }
  return new ShuttleError('UNKNOWN', `通信に失敗しました (${code || 'no code'})`, {
    cause: error,
    details: { url },
  });
}
