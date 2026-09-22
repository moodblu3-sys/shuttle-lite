import { describe, expect, it } from 'vitest';
import { redact } from '@shuttle-lite/core';
import {
  assertProxyUsable,
  buildConfig,
  createDispatcher,
  loadDestinationCatalog,
  parseEnv,
  type ProxyProfile,
  redactProxyUrl,
  shouldBypassProxy,
} from '@shuttle-lite/config';

const fakeEnv = { BOX_MODE: 'fake' } as NodeJS.ProcessEnv;

describe('environment validation', () => {
  it('runs with no credentials in fake mode', () => {
    const config = buildConfig(parseEnv(fakeEnv));
    expect(config.box.mode).toBe('fake');
    expect(config.limits.fileConcurrency).toBe(3);
    expect(config.limits.directUploadMaxBytes).toBe(50 * 1024 * 1024);
  });

  it('demands Box credentials in real mode', () => {
    expect(() => parseEnv({ BOX_MODE: 'real' } as NodeJS.ProcessEnv)).toThrowError(/BOX_CLIENT_ID/);
  });

  it('accepts an explicit access token without any CCG credentials', () => {
    const config = buildConfig(
      parseEnv({ BOX_MODE: 'real', BOX_ACCESS_TOKEN: ' test-only-token ' }),
    );
    expect(config.box.accessToken).toBe('test-only-token');
    expect(config.box.clientId).toBeUndefined();
    expect(config.box.clientSecret).toBeUndefined();
    expect(config.box.enterpriseId).toBeUndefined();
  });

  it('uses the existing CCG requirements when the token is blank', () => {
    expect(() => parseEnv({ BOX_MODE: 'real', BOX_ACCESS_TOKEN: '   ' })).toThrowError(
      /BOX_CLIENT_ID/,
    );
    const config = buildConfig(
      parseEnv({
        BOX_MODE: 'real',
        BOX_ACCESS_TOKEN: '',
        BOX_CLIENT_ID: 'test-client',
        BOX_CLIENT_SECRET: 'test-secret',
        BOX_ENTERPRISE_ID: 'test-enterprise',
      }),
    );
    expect(config.box.accessToken).toBeUndefined();
    expect(config.box.clientId).toBe('test-client');
  });

  it('rejects a Bearer prefix or embedded newlines without exposing the token', () => {
    for (const token of ['Bearer test-only-token', 'test-only-token\nmore']) {
      let message = '';
      try {
        parseEnv({ BOX_MODE: 'real', BOX_ACCESS_TOKEN: token });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('BOX_ACCESS_TOKEN');
      expect(message).not.toContain('test-only-token');
    }
  });

  it('redacts the token in both the raw environment and translated Box config', () => {
    const config = buildConfig(parseEnv({ BOX_MODE: 'real', BOX_ACCESS_TOKEN: 'test-only-token' }));
    const safe = redact(config) as { env: Record<string, unknown>; box: Record<string, unknown> };
    expect(safe.env.BOX_ACCESS_TOKEN).toBe('[redacted]');
    expect(safe.box.accessToken).toBe('[redacted]');
    expect(JSON.stringify(safe)).not.toContain('test-only-token');
  });

  it('demands a proxy URL when the proxy is mandatory', () => {
    expect(() =>
      parseEnv({ BOX_MODE: 'fake', PROXY_MODE: 'required' } as NodeJS.ProcessEnv),
    ).toThrowError(/PROXY_URL/);
  });

  it('demands credentials for basic proxy auth', () => {
    expect(() =>
      parseEnv({
        BOX_MODE: 'fake',
        PROXY_MODE: 'preferred',
        PROXY_URL: 'http://127.0.0.1:3128',
        PROXY_AUTH_MODE: 'basic',
      } as NodeJS.ProcessEnv),
    ).toThrowError(/PROXY_USERNAME/);
  });

  it('demands Snowflake settings before selecting the Snowflake sink', () => {
    expect(() =>
      parseEnv({ BOX_MODE: 'fake', TELEMETRY_SINK: 'snowflake' } as NodeJS.ProcessEnv),
    ).toThrowError(/SNOWFLAKE_ACCOUNT/);
  });
});

describe('proxy profile translation', () => {
  const required: ProxyProfile = {
    name: 'squid',
    mode: 'required',
    url: 'http://user:pass@127.0.0.1:3128',
    authMode: 'basic',
    username: 'user',
    password: 'pass',
    noProxy: ['localhost', '127.0.0.1'],
  };

  it('refuses to fall back to a direct connection when the proxy is mandatory', () => {
    expect(() => createDispatcher({ ...required, url: undefined })).toThrowError(
      /direct接続へfallbackしません/,
    );
  });

  it('routes Box traffic through the proxy', () => {
    const bundle = createDispatcher(required, 'https://api.box.com/2.0/users/me');
    expect(bundle.viaProxy).toBe(true);
    expect(() => assertProxyUsable(required, bundle)).not.toThrow();
    expect(bundle.describe).not.toContain('pass');
  });

  it('keeps NO_PROXY hosts direct without tripping the required check', () => {
    const bundle = createDispatcher(required, 'http://localhost:3000/api/jobs');
    expect(bundle.viaProxy).toBe(false);
    expect(() => assertProxyUsable(required, bundle)).not.toThrow();
  });

  it('never prints proxy credentials', () => {
    expect(redactProxyUrl('http://user:secret@proxy:3128/')).toBe('http://***:***@proxy:3128/');
  });

  it('matches NO_PROXY entries with and without a leading dot, like curl', () => {
    expect(shouldBypassProxy('https://api.box.com/2.0', ['.box.com'])).toBe(true);
    expect(shouldBypassProxy('https://api.box.com/2.0', ['box.com'])).toBe(true);
    expect(shouldBypassProxy('https://api.box.com/2.0', ['notbox.com'])).toBe(false);
    expect(shouldBypassProxy('https://api.box.com/2.0', ['example.com'])).toBe(false);
  });
});

describe('destination catalog', () => {
  it('loads the shipped catalog and includes the needs-review key', () => {
    const catalog = loadDestinationCatalog();
    expect(catalog.entries.map((entry) => entry.key)).toContain('LEGAL_CONTRACTS');
    expect(catalog.entries.some((entry) => entry.key === catalog.needsReviewKey)).toBe(true);
  });
});
