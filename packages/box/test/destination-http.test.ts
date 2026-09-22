import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockAgent } from 'undici';
import { buildConfig, parseEnv } from '@shuttle-lite/config';
import { HttpBoxGateway } from '@shuttle-lite/box';

describe('Box destination HTTP contract', () => {
  let agent: MockAgent;
  let gateway: HttpBoxGateway;
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

  it('uses returned ancestry without needing to fetch inaccessible parent folders', async () => {
    agent
      .get('https://box.invalid')
      .intercept({ path: '/2.0/folders/123?fields=id,name,parent,path_collection' })
      .reply(200, {
        id: '123',
        name: '共有された案件',
        parent: { id: 'private-parent' },
        path_collection: {
          entries: [
            { id: '0', name: 'All Files' },
            { id: 'private-parent', name: '営業部' },
          ],
        },
      });
    expect(await gateway.getFolder('123')).toMatchObject({
      id: '123',
      ancestors: [
        { id: '0', name: 'All Files' },
        { id: 'private-parent', name: '営業部' },
      ],
    });
    agent.assertNoPendingInterceptors();
  });

  it('reads every marker page and excludes web links', async () => {
    agent
      .get('https://box.invalid')
      .intercept({
        path: '/2.0/folders/123/items?fields=id%2Cname%2Csize%2Csha1%2Ctype&limit=1000&usemarker=true',
      })
      .reply(200, {
        entries: [
          { type: 'folder', id: '2', name: '顧客A' },
          { type: 'web_link', id: '3', name: 'link' },
        ],
        next_marker: 'next-page',
      });
    agent
      .get('https://box.invalid')
      .intercept({
        path: '/2.0/folders/123/items?fields=id%2Cname%2Csize%2Csha1%2Ctype&limit=1000&usemarker=true&marker=next-page',
      })
      .reply(200, { entries: [{ type: 'folder', id: '4', name: '顧客B' }], next_marker: null });
    expect((await gateway.listFolder('123')).map((entry) => entry.name)).toEqual([
      '顧客A',
      '顧客B',
    ]);
    agent.assertNoPendingInterceptors();
  });

  it('sends selected names and paths with allowed keys and an explicit no-match option', async () => {
    let sent:
      { fields: { key: string; options?: { key: string }[]; prompt?: string }[] } | undefined;
    agent
      .get('https://box.invalid')
      .intercept({ path: '/2.0/ai/extract_structured', method: 'POST' })
      .reply(200, (request) => {
        sent = JSON.parse(String(request.body));
        return { answer: { suggestedDestinationKey: 'DEST_ABC' } };
      });
    await gateway.extractStructured({
      fileId: '55',
      fileName: '契約書.pdf',
      destinationKeys: ['DEST_ABC'],
      destinations: [
        { key: 'DEST_ABC', label: '営業部/顧客A/契約書', boxPath: '/営業部/顧客A/契約書' },
      ],
    });
    const field = sent!.fields.find((entry) => entry.key === 'suggestedDestinationKey')!;
    expect(field.options).toEqual([{ key: 'DEST_ABC' }, { key: 'NEEDS_REVIEW' }]);
    expect(field.prompt).toContain('営業部/顧客A/契約書');
    expect(field.prompt).not.toContain('LEGAL_CONTRACTS');
    agent.assertNoPendingInterceptors();
  });
});
