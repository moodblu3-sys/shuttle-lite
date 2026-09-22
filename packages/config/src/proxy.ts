import { readFileSync } from 'node:fs';
import { Agent, ProxyAgent, type Dispatcher } from 'undici';
import { ShuttleError } from '@shuttle-lite/core';
import type { ProxyProfile } from './env';

export interface DispatcherBundle {
  readonly dispatcher: Dispatcher;
  readonly describe: string;
  readonly viaProxy: boolean;
}

function readCaBundle(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new ShuttleError('PROXY_TLS', `CA bundleを読み込めません: ${path}`, { cause: error });
  }
}

function basicToken(profile: ProxyProfile): string | undefined {
  if (profile.authMode !== 'basic') return undefined;
  if (!profile.username || !profile.password) {
    throw new ShuttleError('PROXY_AUTH', 'Proxy basic認証のuser名とpasswordが設定されていません');
  }
  const encoded = Buffer.from(`${profile.username}:${profile.password}`).toString('base64');
  return `Basic ${encoded}`;
}

export function shouldBypassProxy(target: string, noProxy: readonly string[]): boolean {
  if (noProxy.length === 0) return false;
  let host: string;
  try {
    host = new URL(target).hostname;
  } catch {
    return false;
  }
  return noProxy.some((entry) => {
    if (entry === '*') return true;
    const normalized = entry.startsWith('.') ? entry.slice(1) : entry;
    return host === normalized || host.endsWith(`.${normalized}`);
  });
}

/**
 * One ProxyProfile is translated explicitly for every client
 * (docs/architecture.md section 9). TLS verification is never disabled, and
 * `required` mode refuses to fall back to a direct connection.
 */
export function createDispatcher(profile: ProxyProfile, target?: string): DispatcherBundle {
  const ca = readCaBundle(profile.caBundlePath);
  const connect = ca ? { ca } : undefined;

  if (profile.mode === 'off') {
    return {
      dispatcher: new Agent(connect ? { connect } : {}),
      describe: 'direct',
      viaProxy: false,
    };
  }

  if (!profile.url) {
    if (profile.mode === 'required') {
      throw new ShuttleError(
        'PROXY_REQUIRED',
        'PROXY_MODE=required ですが PROXY_URL が未設定です。direct接続へfallbackしません。',
      );
    }
    return {
      dispatcher: new Agent(connect ? { connect } : {}),
      describe: 'direct (proxy未設定)',
      viaProxy: false,
    };
  }

  // NO_PROXY hosts stay direct even in required mode. This is how the local
  // UI and a local Squid container keep working.
  if (target && shouldBypassProxy(target, profile.noProxy)) {
    return {
      dispatcher: new Agent(connect ? { connect } : {}),
      describe: `direct (NO_PROXY一致: ${target})`,
      viaProxy: false,
    };
  }

  const token = basicToken(profile);
  const agent = new ProxyAgent({
    uri: profile.url,
    ...(token ? { token } : {}),
    // Applied to the TLS session established through the CONNECT tunnel.
    ...(ca ? { requestTls: { ca }, proxyTls: { ca } } : {}),
  });
  return {
    dispatcher: agent,
    describe: `proxy ${redactProxyUrl(profile.url)} (${profile.authMode})`,
    viaProxy: true,
  };
}

export function redactProxyUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = '***';
      parsed.password = '***';
    }
    return parsed.toString();
  } catch {
    return '(不正なproxy URL)';
  }
}

/**
 * `required` mode must fail loudly rather than silently reaching the internet
 * directly, which is acceptance criterion 2.
 */
export function assertProxyUsable(profile: ProxyProfile, bundle: DispatcherBundle): void {
  if (profile.mode !== 'required') return;
  if (!bundle.viaProxy && !bundle.describe.startsWith('direct (NO_PROXY')) {
    throw new ShuttleError(
      'PROXY_REQUIRED',
      'Proxy必須設定ですが、proxyを経由しないdispatcherが作られました。',
      { details: { describe: bundle.describe } },
    );
  }
}

export interface ProxyCheckTarget {
  readonly label: string;
  readonly url: string;
  readonly method: 'GET' | 'HEAD' | 'OPTIONS';
  readonly expectStatuses: readonly number[];
}

/** Endpoints checked before a migration starts (docs/requirements.md 4.3). */
export function proxyCheckTargets(box: {
  authBaseUrl: string;
  apiBaseUrl: string;
  uploadBaseUrl: string;
}): ProxyCheckTarget[] {
  return [
    {
      label: 'Box auth (account.box.com / api.box.com oauth2)',
      url: `${box.authBaseUrl}/token`,
      method: 'OPTIONS',
      expectStatuses: [200, 204, 400, 401, 405],
    },
    {
      label: 'Box API',
      url: `${box.apiBaseUrl}/users/me`,
      method: 'GET',
      expectStatuses: [401],
    },
    {
      label: 'Box Upload',
      url: `${box.uploadBaseUrl}/files/content`,
      method: 'OPTIONS',
      expectStatuses: [200, 204, 401, 405],
    },
  ];
}
