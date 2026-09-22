import type { Readable } from 'node:stream';
import { request as undiciRequest, type Dispatcher } from 'undici';
import {
  assertProxyUsable,
  createDispatcher,
  type BoxConfig,
  type DispatcherBundle,
  type ProxyProfile,
} from '@shuttle-lite/config';
import { type Logger, ShuttleError } from '@shuttle-lite/core';
import { mapResponseError, mapTransportError, requestIdOf } from './errors';

export interface BoxRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'OPTIONS';
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly body?: string | Buffer | Readable;
  readonly contentLength?: number;
  readonly signal?: AbortSignal;
  /** Statuses that are handled by the caller instead of being thrown. */
  readonly allowStatuses?: readonly number[];
  readonly skipAuth?: boolean;
  readonly timeoutMs?: number;
}

export interface BoxResponse {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly bodyText: string;
  readonly requestId?: string;
}

interface TokenState {
  token: string;
  expiresAtMs: number;
}

/**
 * Thin REST client over undici. Chosen over the official SDK (docs/decisions
 * D-013) so that the proxy dispatcher, the CA bundle, Retry-After handling and
 * chunked-upload recovery stay under application control.
 */
export class BoxHttpClient {
  readonly #box: BoxConfig;
  readonly #proxy: ProxyProfile;
  readonly #logger: Logger | undefined;
  readonly #dispatchers = new Map<string, DispatcherBundle>();
  #token: TokenState | null = null;
  #tokenInFlight: Promise<string> | null = null;

  constructor(options: { box: BoxConfig; proxy: ProxyProfile; logger?: Logger }) {
    this.#box = options.box;
    this.#proxy = options.proxy;
    this.#logger = options.logger;
  }

  /** One dispatcher per origin so NO_PROXY decisions stay per host. */
  dispatcherFor(url: string): DispatcherBundle {
    const origin = new URL(url).origin;
    const cached = this.#dispatchers.get(origin);
    if (cached) return cached;
    const bundle = createDispatcher(this.#proxy, url);
    assertProxyUsable(this.#proxy, bundle);
    this.#dispatchers.set(origin, bundle);
    this.#logger?.debug('box dispatcher created', { origin, route: bundle.describe });
    return bundle;
  }

  async getAccessToken(force = false): Promise<string> {
    // A supplied token fixes the identity for this process. Never fall back to
    // CCG (a potentially different user), including after a 401 or force refresh.
    if (this.#box.accessToken) return this.#box.accessToken;
    if (!force && this.#token && this.#token.expiresAtMs > Date.now() + 60_000) {
      return this.#token.token;
    }
    if (this.#tokenInFlight && !force) return this.#tokenInFlight;
    this.#tokenInFlight = this.#fetchToken().finally(() => {
      this.#tokenInFlight = null;
    });
    return this.#tokenInFlight;
  }

  async #fetchToken(): Promise<string> {
    const { clientId, clientSecret, enterpriseId, authBaseUrl } = this.#box;
    if (!clientId || !clientSecret || !enterpriseId) {
      throw new ShuttleError(
        'BOX_AUTH',
        'CCGに必要な BOX_CLIENT_ID / BOX_CLIENT_SECRET / BOX_ENTERPRISE_ID が設定されていません',
      );
    }
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      box_subject_type: 'enterprise',
      box_subject_id: enterpriseId,
    });
    const response = await this.request({
      method: 'POST',
      url: `${authBaseUrl}/token`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      skipAuth: true,
    });
    const parsed = JSON.parse(response.bodyText) as { access_token?: string; expires_in?: number };
    if (!parsed.access_token) {
      throw new ShuttleError('BOX_AUTH', 'CCG tokenのresponseに access_token がありません', {
        requestId: response.requestId,
      });
    }
    this.#token = {
      token: parsed.access_token,
      expiresAtMs: Date.now() + (parsed.expires_in ?? 3600) * 1000,
    };
    return this.#token.token;
  }

  async request(request: BoxRequest): Promise<BoxResponse> {
    const bundle = this.dispatcherFor(request.url);
    const headers: Record<string, string> = { ...request.headers };
    if (!request.skipAuth) {
      headers.authorization = `Bearer ${await this.getAccessToken()}`;
    }
    if (request.contentLength !== undefined) {
      headers['content-length'] = String(request.contentLength);
    }

    let response: Dispatcher.ResponseData;
    try {
      response = await undiciRequest(request.url, {
        method: request.method,
        headers,
        ...(request.body === undefined ? {} : { body: request.body }),
        dispatcher: bundle.dispatcher,
        ...(request.signal ? { signal: request.signal } : {}),
        headersTimeout: request.timeoutMs ?? 60_000,
        bodyTimeout: request.timeoutMs ?? 300_000,
      });
    } catch (error) {
      throw mapTransportError(error, bundle.viaProxy, request.url);
    }

    const bodyText = await response.body.text();
    const result: BoxResponse = {
      status: response.statusCode,
      headers: response.headers as Record<string, string | string[] | undefined>,
      bodyText,
      requestId: requestIdOf(response.headers as Record<string, string | string[] | undefined>),
    };

    if (result.status === 401 && !request.skipAuth) {
      // The token may simply have aged out; drop it so the next call re-authenticates.
      this.#token = null;
    }
    if (result.status >= 400 && !(request.allowStatuses ?? []).includes(result.status)) {
      if (result.status === 401 && !request.skipAuth && this.#box.accessToken) {
        throw new ShuttleError(
          'BOX_AUTH',
          'BOX_ACCESS_TOKEN が無効または期限切れです。.envのトークンを更新し、アプリを再起動してください。',
          { status: result.status, requestId: result.requestId },
        );
      }
      throw mapResponseError(result.status, result.headers, bodyText, {
        url: request.url,
        method: request.method,
        route: bundle.describe,
      });
    }
    return result;
  }

  async json<T>(request: BoxRequest): Promise<T> {
    const response = await this.request({
      ...request,
      headers: { accept: 'application/json', ...request.headers },
    });
    if (response.bodyText.trim() === '') return {} as T;
    try {
      return JSON.parse(response.bodyText) as T;
    } catch (error) {
      throw new ShuttleError('BOX_BAD_REQUEST', 'Box responseをJSONとして解析できません', {
        cause: error,
        requestId: response.requestId,
        details: { url: request.url },
      });
    }
  }

  async close(): Promise<void> {
    for (const bundle of this.#dispatchers.values()) {
      await bundle.dispatcher.close();
    }
    this.#dispatchers.clear();
  }
}
