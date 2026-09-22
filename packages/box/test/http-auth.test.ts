import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockAgent } from 'undici';
import { buildConfig, parseEnv } from '@shuttle-lite/config';
import { ShuttleError } from '@shuttle-lite/core';
import { BoxHttpClient, HttpBoxGateway } from '@shuttle-lite/box';

const TOKEN = 'test-only-fixed-token';
const API = 'https://api.box.invalid';
const UPLOAD = 'https://upload.box.invalid';
const ccg = {
  BOX_CLIENT_ID: 'test-client',
  BOX_CLIENT_SECRET: 'test-secret',
  BOX_ENTERPRISE_ID: 'test-enterprise',
};
const agents: MockAgent[] = [];

function harness(auth: NodeJS.ProcessEnv) {
  const config = buildConfig(
    parseEnv({
      BOX_MODE: 'real',
      BOX_API_BASE_URL: `${API}/2.0`,
      BOX_UPLOAD_BASE_URL: `${UPLOAD}/api/2.0`,
      BOX_AUTH_BASE_URL: `${API}/oauth2`,
      ...auth,
    }),
  );
  const agent = new MockAgent();
  agent.disableNetConnect();
  agents.push(agent);
  const gateway = new HttpBoxGateway({ box: config.box, proxy: config.proxy });
  const dispatch = vi.spyOn(gateway.client, 'dispatcherFor').mockReturnValue({
    dispatcher: agent,
    viaProxy: false,
    describe: 'test dispatcher',
  });
  return { agent, gateway, client: gateway.client, dispatch };
}

afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.close()));
  vi.restoreAllMocks();
});

describe('Box HTTP authentication', () => {
  it('uses the configured token for identity and upload requests without calling OAuth', async () => {
    const { agent, gateway, client, dispatch } = harness({ BOX_ACCESS_TOKEN: TOKEN });
    agent
      .get(API)
      .intercept({ path: '/2.0/users/me', headers: { authorization: `Bearer ${TOKEN}` } })
      .reply(200, { id: '123', login: 'demo@example.test', name: 'Demo' });
    agent
      .get(UPLOAD)
      .intercept({
        path: '/api/2.0/files/content',
        method: 'POST',
        body: 'demo bytes',
        headers: { authorization: `Bearer ${TOKEN}` },
      })
      .reply(201, { entries: [] });
    expect(await gateway.whoAmI()).toMatchObject({ userId: '123', login: 'demo@example.test' });
    expect(
      (
        await client.request({
          method: 'POST',
          url: `${UPLOAD}/api/2.0/files/content`,
          body: 'demo bytes',
        })
      ).status,
    ).toBe(201);
    expect(dispatch.mock.calls.map(([url]) => url)).toEqual([
      `${API}/2.0/users/me`,
      `${UPLOAD}/api/2.0/files/content`,
    ]);
    agent.assertNoPendingInterceptors();
  });

  it('gives the explicit token precedence even with CCG settings or a forced refresh', async () => {
    const { client, dispatch } = harness({ ...ccg, BOX_ACCESS_TOKEN: TOKEN });
    expect(await client.getAccessToken()).toBe(TOKEN);
    expect(await client.getAccessToken(true)).toBe(TOKEN);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('reports a rejected token without refreshing, changing identity or echoing a credential', async () => {
    const { agent, client, dispatch } = harness({ ...ccg, BOX_ACCESS_TOKEN: TOKEN });
    agent
      .get(API)
      .intercept({ path: '/2.0/users/me', headers: { authorization: `Bearer ${TOKEN}` } })
      .reply(
        401,
        { message: `Rejected ${TOKEN}` },
        { headers: { 'box-request-id': 'test-request' } },
      )
      .times(2);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const failure = await client
        .request({ method: 'GET', url: `${API}/2.0/users/me` })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ShuttleError);
      const error = failure as ShuttleError;
      expect(error.category).toBe('BOX_AUTH');
      expect(error.status).toBe(401);
      expect(error.requestId).toBe('test-request');
      expect(error.retryable).toBe(false);
      expect(error.message).toContain('再起動');
      expect(error.operatorAction).toContain('BOX_ACCESS_TOKEN');
      expect(JSON.stringify(error)).not.toContain(TOKEN);
    }
    expect(dispatch.mock.calls.map(([url]) => url)).toEqual([
      `${API}/2.0/users/me`,
      `${API}/2.0/users/me`,
    ]);
    agent.assertNoPendingInterceptors();
  });

  it('preserves CCG token sharing, caching and re-authentication after a 401', async () => {
    const { agent, client, dispatch } = harness(ccg);
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: ccg.BOX_CLIENT_ID,
      client_secret: ccg.BOX_CLIENT_SECRET,
      box_subject_type: 'enterprise',
      box_subject_id: ccg.BOX_ENTERPRISE_ID,
    }).toString();
    for (const token of ['test-ccg-first', 'test-ccg-second']) {
      agent
        .get(API)
        .intercept({
          path: '/oauth2/token',
          method: 'POST',
          body: form,
          headers: (headers) => !headers.authorization,
        })
        .reply(200, { access_token: token, expires_in: 3600 });
    }
    agent
      .get(API)
      .intercept({ path: '/2.0/users/me', headers: { authorization: 'Bearer test-ccg-first' } })
      .reply(200, { id: '123' })
      .times(2);
    agent
      .get(API)
      .intercept({ path: '/2.0/users/me', headers: { authorization: 'Bearer test-ccg-first' } })
      .reply(401, { code: 'invalid_token' });
    agent
      .get(API)
      .intercept({ path: '/2.0/users/me', headers: { authorization: 'Bearer test-ccg-second' } })
      .reply(200, { id: '123' });
    const request = { method: 'GET' as const, url: `${API}/2.0/users/me` };
    await Promise.all([client.request(request), client.request(request)]);
    expect(dispatch.mock.calls.filter(([url]) => url.endsWith('/oauth2/token'))).toHaveLength(1);
    await expect(client.request(request)).rejects.toMatchObject({ category: 'BOX_AUTH' });
    expect((await client.request(request)).status).toBe(200);
    expect(dispatch.mock.calls.filter(([url]) => url.endsWith('/oauth2/token'))).toHaveLength(2);
    agent.assertNoPendingInterceptors();
  });

  it('does not attach a token to requests explicitly marked skipAuth', async () => {
    const { agent, client } = harness({ BOX_ACCESS_TOKEN: TOKEN });
    agent
      .get(API)
      .intercept({ path: '/public', headers: (headers) => !headers.authorization })
      .reply(200, 'ok');
    expect(
      (await client.request({ method: 'GET', url: `${API}/public`, skipAuth: true })).status,
    ).toBe(200);
    agent.assertNoPendingInterceptors();
  });

  it('keeps permission failures distinct from token expiration', async () => {
    const { agent, client } = harness({ BOX_ACCESS_TOKEN: TOKEN });
    agent
      .get(API)
      .intercept({ path: '/2.0/folders/123', headers: { authorization: `Bearer ${TOKEN}` } })
      .reply(403, { code: 'access_denied_insufficient_permissions' });
    await expect(
      client.request({ method: 'GET', url: `${API}/2.0/folders/123` }),
    ).rejects.toMatchObject({ category: 'BOX_PERMISSION' });
    agent.assertNoPendingInterceptors();
  });

  it('does not bypass a required proxy when a token is supplied', async () => {
    const config = buildConfig(parseEnv({ BOX_MODE: 'real', BOX_ACCESS_TOKEN: TOKEN }));
    const client = new BoxHttpClient({
      box: config.box,
      proxy: { ...config.proxy, mode: 'required', url: undefined },
    });
    try {
      await expect(
        client.request({ method: 'GET', url: `${API}/2.0/users/me` }),
      ).rejects.toMatchObject({ category: 'PROXY_REQUIRED' });
    } finally {
      await client.close();
    }
  });
});
