import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getStore } from '../src/lib/runtime';
import JobLayout from '../src/app/jobs/[jobId]/layout';
import HistoryPage from '../src/app/jobs/[jobId]/history/page';
import DeltaPage from '../src/app/jobs/[jobId]/delta/page';
import { GET } from '../src/app/api/jobs/[jobId]/delta/route';
import { createHarness, type Harness } from '../../../test/harness';

vi.mock('../src/lib/runtime', () => ({ getStore: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  notFound: () => {
    throw new Error('not-found');
  },
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
}));

describe('job navigation pages', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
    vi.mocked(getStore).mockReturnValue(h.store);
  });
  afterEach(() => h.cleanup());

  it.each(['AI_ORGANIZE', 'AS_IS'] as const)(
    'keeps %s tabs available before completion and renders its history',
    async (migrationMode) => {
      const job = h.store.createJob({
        profileId: h.createProfile().id,
        operatorLabel: 'tester',
        migrationMode,
      });
      const params = Promise.resolve({ jobId: job.id });
      const html = renderToStaticMarkup(await JobLayout({ params, children: 'content' }));
      expect(html).toContain(`/jobs/${job.id}/history`);
      expect(html).toContain(`/jobs/${job.id}/${migrationMode === 'AS_IS' ? 'delta' : 'review'}`);
      expect(html).not.toContain('disabled');
      const history = renderToStaticMarkup(await HistoryPage({ params }));
      expect(history).toContain('初回移行');
      expect(history).toContain(`/api/jobs/${job.id}/report?format=csv`);
      const status = (await (await GET(new Request('http://localhost'), { params })).json()) as {
        eligible: boolean;
      };
      expect(status.eligible).toBe(false);
    },
  );

  it('keeps a test-mode delta tab reachable with a clear restriction and no actions', async () => {
    const job = h.store.createJob({
      profileId: h.createProfile().id,
      operatorLabel: 'tester',
      migrationMode: 'AS_IS',
      testMode: true,
    });
    const params = Promise.resolve({ jobId: job.id });
    const html = renderToStaticMarkup(await DeltaPage({ params }));
    expect(html).toContain('テストモードでは差分移行できません');
    expect(html).not.toContain('<button');
    const status = (await (await GET(new Request('http://localhost'), { params })).json()) as {
      eligible: boolean;
    };
    expect(status.eligible).toBe(false);
  });

  it('redirects an AI job away from delta actions and rejects missing jobs', async () => {
    const job = h.store.createJob({ profileId: h.createProfile().id, operatorLabel: 'tester' });
    await expect(DeltaPage({ params: Promise.resolve({ jobId: job.id }) })).rejects.toThrow(
      `redirect:/jobs/${job.id}`,
    );
    await expect(HistoryPage({ params: Promise.resolve({ jobId: 'missing' }) })).rejects.toThrow(
      'not-found',
    );
  });
});
