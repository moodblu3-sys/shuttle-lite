import { demoBusinessTemplates } from '../src/fake/business-templates';
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

  it('lists all template pages and extracts using the selected Box template', async () => {
    const template = demoBusinessTemplates[1]!;
    const pool = agent.get('https://box.invalid');
    pool.intercept({ path: '/2.0/metadata_templates/enterprise?limit=100' }).reply(200, {
      entries: [{ scope: template.scope, templateKey: template.templateKey }],
      next_marker: 'second',
    });
    pool
      .intercept({
        path: `/2.0/metadata_templates/${template.scope}/${template.templateKey}/schema`,
      })
      .reply(200, template);
    pool
      .intercept({ path: '/2.0/metadata_templates/enterprise?limit=100&marker=second' })
      .reply(200, { entries: [], next_marker: null });
    expect(await gateway.listMetadataTemplates()).toEqual([template]);
    pool
      .intercept({
        path: '/2.0/ai/extract_structured',
        method: 'POST',
        body: JSON.stringify({
          items: [{ id: '123', type: 'file' }],
          metadata_template: {
            type: 'metadata_template',
            scope: template.scope,
            template_key: template.templateKey,
          },
        }),
      })
      .reply(200, { answer: { amount: 12500 } });
    expect(await gateway.extractTemplate('123', template)).toEqual({ amount: 12500 });
    agent.assertNoPendingInterceptors();
  });

  it('writes the selected template and removes cleared values without writing internal fields', async () => {
    const template = demoBusinessTemplates[1]!;
    const path = `/2.0/files/123/metadata/${template.scope}/${template.templateKey}`;
    const pool = agent.get('https://box.invalid');
    pool
      .intercept({ path, method: 'POST', body: JSON.stringify({ vendor: '青葉', amount: 12500 }) })
      .reply(201, {});
    await gateway.setMetadata('123', { vendor: '青葉', amount: 12500 }, template);
    pool
      .intercept({ path, method: 'GET' })
      .reply(200, { vendor: '青葉', amount: 12500, $id: 'instance' });
    pool
      .intercept({
        path,
        method: 'PUT',
        body: JSON.stringify([
          { op: 'replace', path: '/vendor', value: '修正後' },
          { op: 'remove', path: '/amount' },
        ]),
      })
      .reply(200, { vendor: '修正後' });
    await gateway.updateMetadata('123', { vendor: '修正後' }, template);
    pool.intercept({ path, method: 'DELETE' }).reply(204);
    await gateway.removeBusinessMetadata('123', template);
    agent.assertNoPendingInterceptors();
  });

  it('deletes the exact file with an etag guard and never requests permanent trash purge', async () => {
    agent
      .get('https://box.invalid')
      .intercept({ path: '/2.0/files/123', method: 'DELETE', headers: { 'if-match': '7' } })
      .reply(204);
    await gateway.deleteTestFile('123', '7');
    agent.assertNoPendingInterceptors();
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

  it('sends template names and fields as constrained AI choices alongside destinations', async () => {
    let sent:
      | { fields: { key: string; type: string; prompt?: string; options?: { key: string }[] }[] }
      | undefined;
    agent
      .get('https://box.invalid')
      .intercept({ path: '/2.0/ai/extract_structured', method: 'POST' })
      .reply(200, (request) => {
        sent = JSON.parse(String(request.body));
        return { answer: { metadataTemplateId: 'enterprise/shuttleLiteContract' } };
      });
    await gateway.extractStructured({
      fileId: '55',
      fileName: '書類.pdf',
      destinationKeys: ['DEST_A'],
      metadataTemplates: demoBusinessTemplates,
    });
    const field = sent!.fields.find((entry) => entry.key === 'metadataTemplateId')!;
    expect(field.type).toBe('enum');
    expect(field.options).toEqual([
      ...demoBusinessTemplates.map((t) => ({ key: `${t.scope}/${t.templateKey}` })),
      { key: 'NONE' },
    ]);
    expect(field.prompt).toContain('契約書管理');
    expect(field.prompt).toContain('counterparty');
    expect(field.prompt).toContain('契約先');
    expect(field.prompt).toContain('区別できない');
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
