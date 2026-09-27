import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockAgent } from 'undici';
import { buildConfig, parseEnv } from '@shuttle-lite/config';
import { HttpBoxGateway } from '../src/http/gateway';

describe('existing Box file version HTTP contract', () => {
  let agent: MockAgent;
  let gateway: HttpBoxGateway;
  beforeEach(() => {
    const config = buildConfig(
      parseEnv({
        BOX_MODE: 'real',
        BOX_ACCESS_TOKEN: 'test-only',
        BOX_UPLOAD_BASE_URL: 'https://upload.invalid/2.0',
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
  it('targets the existing ID and preserves the If-Match guard on direct upload', async () => {
    agent
      .get('https://upload.invalid')
      .intercept({
        method: 'POST',
        path: /^\/2.0\/files\/123\/content\?fields=/,
        headers: { 'if-match': '7' },
      })
      .reply(200, {
        entries: [
          {
            id: '123',
            name: 'A.txt',
            size: 3,
            sha1: 'digest',
            etag: '8',
            parent: { id: 'folder' },
            file_version: { id: 'v2' },
          },
        ],
      });
    const result = await gateway.uploadDirect({
      parentFolderId: 'folder',
      name: 'A.txt',
      size: 3,
      sha1Hex: 'a'.repeat(40),
      content: () => Readable.from(Buffer.from('new')),
      versionTarget: { fileId: '123', etag: '7' },
    });
    expect(result).toMatchObject({ id: '123', versionId: 'v2' });
    agent.assertNoPendingInterceptors();
  });
  it('creates an existing-file session and guards its commit', async () => {
    const pool = agent.get('https://upload.invalid');
    pool
      .intercept({
        method: 'POST',
        path: '/2.0/files/123/upload_sessions',
        body: JSON.stringify({ file_name: 'A.txt', file_size: 100 }),
      })
      .reply(201, { id: 's1', part_size: 50, total_parts: 2 });
    await gateway.createUploadSession({
      parentFolderId: 'folder',
      name: 'A.txt',
      size: 100,
      versionTarget: { fileId: '123', etag: '7' },
    });
    pool
      .intercept({
        method: 'POST',
        path: '/2.0/files/upload_sessions/s1/commit',
        headers: { 'if-match': '7' },
      })
      .reply(412, { code: 'precondition_failed', message: 'changed' });
    await expect(
      gateway.commitUploadSession({
        sessionId: 's1',
        sha1Hex: 'a'.repeat(40),
        parts: [],
        ifMatch: '7',
      }),
    ).rejects.toMatchObject({ category: 'BOX_PRECONDITION' });
    agent.assertNoPendingInterceptors();
  });
});
