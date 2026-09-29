import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockAgent } from 'undici';
import { buildConfig, parseEnv } from '@shuttle-lite/config';
import { AuthStore, migrate, openDatabase } from '@shuttle-lite/db';
import { BoxOAuth } from '../src/oauth';
import { BoxHttpClient } from '../src/http/client';

const config = buildConfig(
  parseEnv({
    BOX_MODE: 'real',
    BOX_AUTH_MODE: 'oauth',
    BOX_CLIENT_ID: 'client',
    BOX_CLIENT_SECRET: 'secret',
    BOX_ENTERPRISE_ID: '99',
    SHUTTLE_AUTH_KEY: 'ab'.repeat(32),
    SHUTTLE_ADMIN_USER_IDS: '11',
    BOX_ROOT_FOLDER_ID: 'old-sa-root',
  }),
);
const user = { id: '11', name: '山田', login: 'yamada@example.test', enterpriseId: '99' };
describe('Box user OAuth', () => {
  const db = openDatabase({ path: ':memory:' });
  migrate(db);
  const auth = new AuthStore(db, config.env.SHUTTLE_AUTH_KEY!);
  let oauth: BoxOAuth;
  let agent: MockAgent;
  beforeEach(() => {
    oauth = new BoxOAuth(config, auth);
    agent = new MockAgent();
    agent.disableNetConnect();
    vi.spyOn(oauth.client, 'dispatcherFor').mockReturnValue({
      dispatcher: agent,
      viaProxy: false,
      describe: 'mock',
    });
  });
  afterEach(async () => {
    await agent.close();
    await oauth.close();
    vi.restoreAllMocks();
    db.exec('DELETE FROM auth_users');
  });

  it('authorizes against the registered redirect and verifies the enterprise and user ID', async () => {
    const url = new URL(oauth.authorizationUrl('state'));
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3000/api/auth/callback');
    expect(url.searchParams.get('state')).toBe('state');
    agent
      .get('https://api.box.com')
      .intercept({
        path: '/oauth2/token',
        method: 'POST',
        body: (body) => new URLSearchParams(body).get('grant_type') === 'authorization_code',
      })
      .reply(200, { access_token: 'user-access', refresh_token: 'user-refresh', expires_in: 3600 });
    agent
      .get('https://api.box.com')
      .intercept({
        path: '/2.0/users/me?fields=id,name,login,enterprise,status',
        headers: { authorization: 'Bearer user-access' },
      })
      .reply(200, { ...user, enterprise: { id: '99' }, status: 'active' });
    expect(await oauth.authorize('code')).toEqual(user);
    expect(await oauth.accessToken(user.id)).toBe('user-access');
    agent.assertNoPendingInterceptors();
  });

  it.each([
    { enterprise: { id: 'other' }, status: 'active' },
    { enterprise: { id: '99' }, status: 'inactive' },
    { status: 'active' },
  ])('rejects unauthorized accounts %j', async (identity) => {
    agent
      .get('https://api.box.com')
      .intercept({ path: '/oauth2/token', method: 'POST' })
      .reply(200, { access_token: 'access', refresh_token: 'refresh', expires_in: 3600 });
    agent
      .get('https://api.box.com')
      .intercept({ path: '/2.0/users/me?fields=id,name,login,enterprise,status' })
      .reply(200, { ...user, ...identity });
    await expect(oauth.authorize('code')).rejects.toMatchObject({ category: 'BOX_AUTH' });
    expect(auth.getUser(user.id)).toBeNull();
  });

  it('serializes token rotation across concurrent web and worker services', async () => {
    auth.saveUser(user, { accessToken: 'expired', refreshToken: 'once', expiresAt: 0 });
    const worker = new BoxOAuth(config, auth);
    vi.spyOn(worker.client, 'dispatcherFor').mockReturnValue({
      dispatcher: agent,
      viaProxy: false,
      describe: 'mock',
    });
    agent
      .get('https://api.box.com')
      .intercept({
        path: '/oauth2/token',
        method: 'POST',
        body: (body) => new URLSearchParams(body).get('refresh_token') === 'once',
      })
      .reply(200, { access_token: 'rotated', refresh_token: 'next-once', expires_in: 3600 })
      .delay(20);
    expect(
      await Promise.all([
        oauth.accessToken('11'),
        oauth.accessToken('11'),
        worker.accessToken('11'),
      ]),
    ).toEqual(['rotated', 'rotated', 'rotated']);
    expect(auth.getTokens('11')?.refreshToken).toBe('next-once');
    agent.assertNoPendingInterceptors();
    await worker.close();
  });

  it('invalidates a failed refresh without replay or service-account fallback', async () => {
    auth.saveUser(user, { accessToken: 'expired', refreshToken: 'secret-refresh', expiresAt: 0 });
    agent
      .get('https://api.box.com')
      .intercept({ path: '/oauth2/token', method: 'POST' })
      .reply(400, { error_description: 'secret-refresh secret' });
    await expect(oauth.accessToken('11')).rejects.toMatchObject({ category: 'BOX_AUTH' });
    expect(auth.getTokens('11')).toBeNull();
    await expect(oauth.accessToken('11')).rejects.toThrow('ログイン');
    agent.assertNoPendingInterceptors();
  });

  it('isolates user layout caches and tokens and removes shared service-account folders', async () => {
    auth.saveUser(user, {
      accessToken: 'alice',
      refreshToken: 'a',
      expiresAt: Date.now() + 3600_000,
    });
    auth.saveUser(
      { ...user, id: '22' },
      { accessToken: 'bob', refreshToken: 'b', expiresAt: Date.now() + 3600_000 },
    );
    expect(oauth.userConfig('11').dataDir).not.toBe(oauth.userConfig('22').dataDir);
    expect(oauth.userConfig('11').box.rootFolderId).toBeUndefined();
    const a = new BoxHttpClient({
      box: { ...oauth.userConfig('11').box, accessToken: 'do-not-use' },
      proxy: config.proxy,
    });
    expect(await a.getAccessToken()).toBe('alice');
    expect(await oauth.userConfig('22').box.tokenProvider!()).toBe('bob');
    expect(() => oauth.userConfig('../11')).toThrow();
  });
});
