import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockAgent } from 'undici';
import { buildConfig, parseEnv } from '@shuttle-lite/config';
import { HttpBoxGateway } from '@shuttle-lite/box';

describe('Box expiring preview', () => {
  let agent: MockAgent;
  let gateway: HttpBoxGateway;
  const path = '/2.0/files/123?fields=id,sha1,file_version,expiring_embed_link';
  beforeEach(() => {
    const config = buildConfig(
      parseEnv({
        BOX_MODE: 'real',
        BOX_ACCESS_TOKEN: 'test-only',
        BOX_API_BASE_URL: 'https://box.invalid/2.0',
      }),
    );
    agent = new MockAgent();
    agent.disableNetConnect();
    gateway = new HttpBoxGateway({ box: config.box, proxy: config.proxy });
    vi.spyOn(gateway.client, 'dispatcherFor').mockReturnValue({
      dispatcher: agent,
      viaProxy: false,
      describe: 'test',
    });
  });
  afterEach(async () => {
    await gateway.close();
    await agent.close();
    vi.restoreAllMocks();
  });
  it('requests only preview fields and strips the token from the result', async () => {
    const url = 'https://cloud.app.box.com/preview/expiring_embed/test-only';
    agent
      .get('https://box.invalid')
      .intercept({
        path,
        method: 'GET',
        headers: { authorization: 'Bearer test-only' },
      })
      .reply(200, {
        id: '123',
        sha1: 'abc',
        file_version: { id: '7' },
        expiring_embed_link: { url, token: { access_token: 'must-not-reach-browser' } },
      });
    expect(await gateway.getFilePreview('123')).toEqual({
      fileId: '123',
      versionId: '7',
      sha1: 'abc',
      url,
    });
    agent.assertNoPendingInterceptors();
  });
  it('handles removed files', async () => {
    agent.get('https://box.invalid').intercept({ path }).reply(404, {});
    expect(await gateway.getFilePreview('123')).toBeNull();
  });
  it.each([
    null,
    {},
    { id: '123', sha1: 'abc', file_version: { id: '7' } },
    { id: '123', sha1: 'abc', file_version: { id: '7' }, expiring_embed_link: { url: 123 } },
  ])('rejects incomplete responses without exposing their contents', async (body) => {
    agent.get('https://box.invalid').intercept({ path }).reply(200, JSON.stringify(body));
    await expect(gateway.getFilePreview('123')).rejects.toThrow(
      'Boxからプレビューを取得できませんでした',
    );
  });
  it('preserves rate-limit information for the caller', async () => {
    agent
      .get('https://box.invalid')
      .intercept({ path })
      .reply(429, {}, { headers: { 'retry-after': '12' } });
    await expect(gateway.getFilePreview('123')).rejects.toMatchObject({
      category: 'BOX_RATE_LIMIT',
      retryAfterMs: 12000,
    });
  });
});
