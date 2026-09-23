import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, PUT } from '../apps/web/src/app/api/metadata-settings/route';
import { getBoxGateway, getStore } from '../apps/web/src/lib/runtime';
import { createHarness, type Harness } from './harness';
import { demoBusinessTemplates } from '../packages/box/src/fake/business-templates';

vi.mock('../apps/web/src/lib/runtime', () => ({ getBoxGateway: vi.fn(), getStore: vi.fn() }));

describe('metadata template settings', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
    vi.mocked(getStore).mockReturnValue(h.store);
    vi.mocked(getBoxGateway).mockReturnValue(h.gateway);
    for (const template of demoBusinessTemplates) await h.gateway.createMetadataTemplate(template);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    h.cleanup();
  });
  function request(
    revision = 0,
    mappings: unknown = demoBusinessTemplates.map((template, index) => ({
      documentType: index === 0 ? '契約書' : '請求書',
      scope: template.scope,
      templateKey: template.templateKey,
    })),
  ) {
    return new Request('http://localhost/api/metadata-settings', {
      method: 'PUT',
      headers: {
        origin: 'http://localhost',
        'x-shuttle-settings': '1',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ revision, mappings }),
    });
  }
  it('saves actual Box schemas with revision checks and leaves job snapshots unchanged', async () => {
    const available = await GET();
    expect(((await available.json()) as { templates: unknown[] }).templates).toHaveLength(2);
    expect((await PUT(request())).status).toBe(200);
    const saved = h.store.getMetadataSettings();
    expect(saved.mappings[0]?.template.fields).toEqual(demoBusinessTemplates[0]!.fields);
    const profile = h.createProfile();
    const job = h.store.createJob({ profileId: profile.id, operatorLabel: '担当者' });
    h.store.saveJobMetadata(job.id, saved.mappings);
    expect((await PUT(request())).status).toBe(409);
    expect((await PUT(request(1, []))).status).toBe(200);
    expect(h.store.getJobMetadata(job.id)).toEqual(saved.mappings);
  });
  it('rejects invalid, missing and duplicate mappings without changing settings', async () => {
    for (const mappings of [
      [{ documentType: '契約書', scope: 'enterprise', templateKey: 'missing' }],
      [{ documentType: '契約書', scope: '../', templateKey: 'test' }],
      ['契約書', '請求書'].map((documentType) => ({
        documentType,
        scope: demoBusinessTemplates[0]!.scope,
        templateKey: demoBusinessTemplates[0]!.templateKey,
      })),
    ])
      expect((await PUT(request(0, mappings))).status).toBe(400);
    expect(h.store.getMetadataSettings().revision).toBe(0);
  });
  it('rejects settings from a different origin', async () => {
    const input = request();
    input.headers.set('origin', 'https://other.invalid');
    expect((await PUT(input)).status).toBe(403);
  });
});
