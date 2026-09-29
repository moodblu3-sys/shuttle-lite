import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthStore } from '@shuttle-lite/db';
import type { BusinessTemplate } from '@shuttle-lite/core';
import { createHarness, type Harness } from './harness';
import { getConfig, getStore, getBoxGateway } from '../apps/web/src/lib/runtime';
import { guard, requirePageUser } from '../apps/web/src/lib/auth';
import { GET as listJobs, POST as createJob } from '../apps/web/src/app/api/jobs/route';
import { POST as command } from '../apps/web/src/app/api/jobs/[jobId]/commands/route';
import { GET as snapshot } from '../apps/web/src/app/api/jobs/[jobId]/snapshot/route';
import { GET as events } from '../apps/web/src/app/api/jobs/[jobId]/events/route';
import { GET as report } from '../apps/web/src/app/api/jobs/[jobId]/report/route';
import { GET as review } from '../apps/web/src/app/api/jobs/[jobId]/review/route';
import { GET as delta } from '../apps/web/src/app/api/jobs/[jobId]/delta/route';
import { POST as logout } from '../apps/web/src/app/api/auth/logout/route';
import { GET as callback } from '../apps/web/src/app/api/auth/callback/route';
import { buildTelemetryPayload } from '@shuttle-lite/telemetry';
import { GET as listTemplates } from '../apps/web/src/app/api/metadata-settings/route';

vi.mock('../apps/web/src/lib/runtime', () => ({
  getConfig: vi.fn(),
  getStore: vi.fn(),
  getBoxGateway: vi.fn(),
  getCatalog: vi.fn(),
}));
const browser = vi.hoisted(() => ({ token: '' }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: browser.token }) }),
}));
vi.mock('next/navigation', () => ({
  redirect: () => {
    throw new Error('login');
  },
  notFound: () => {
    throw new Error('not-found');
  },
}));

let h: Harness;
let auth: AuthStore;
let alice: string;
let bob: string;
let jobId: string;
function request(path: string, token = alice, body?: unknown, origin = 'http://localhost:3000') {
  return new Request(`http://localhost:3000${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { cookie: `shuttle_session=${token}`, origin, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(async () => {
  h = await createHarness();
  auth = new AuthStore(h.store.db, 'ab'.repeat(32));
  for (const [id, name] of [
    ['11', '山田'],
    ['22', '佐藤'],
  ])
    auth.saveUser(
      { id: id!, name: name!, login: `${id}@example.test`, enterpriseId: '99' },
      {
        accessToken: `secret-${id}`,
        refreshToken: `refresh-${id}`,
        expiresAt: Date.now() + 3600_000,
      },
    );
  alice = auth.createSession('11');
  bob = auth.createSession('22');
  browser.token = alice;
  vi.mocked(getStore).mockReturnValue(h.store);
  vi.mocked(getConfig).mockReturnValue({
    ...h.config,
    box: { ...h.config.box, enterpriseId: '99' },
    env: {
      ...h.config.env,
      BOX_AUTH_MODE: 'oauth',
      SHUTTLE_AUTH_KEY: 'ab'.repeat(32),
      SHUTTLE_APP_URL: 'http://localhost:3000',
      SHUTTLE_ADMIN_USER_IDS: '11',
    },
  });
  vi.mocked(getBoxGateway).mockResolvedValue(h.gateway);
  jobId = h.store.createJob({
    profileId: h.createProfile().id,
    operatorLabel: '山田',
    ownerUserId: '11',
  }).id;
});
afterEach(() => {
  h.cleanup();
  vi.restoreAllMocks();
});

describe('authenticated web access', () => {
  it('rejects anonymous, expired, other-user and legacy-ownerless access', async () => {
    expect((await guard(request('/', 'forged')))?.status).toBe(401);
    const legacy = h.store.createJob({ profileId: h.createProfile().id, operatorLabel: 'old' });
    expect((await guard(request('/'), legacy.id))?.status).toBe(404);
    expect((await guard(request('/', bob), jobId))?.status).toBe(404);
    expect(await guard(request('/'), jobId)).toBeNull();
    auth.deleteSession(alice);
    expect((await guard(request('/'), jobId))?.status).toBe(401);
  });

  it('filters listings by owner, including before the limit is applied', async () => {
    for (let i = 0; i < 22; i++)
      h.store.createJob({
        profileId: h.createProfile().id,
        operatorLabel: '佐藤',
        ownerUserId: '22',
      });
    const response = await listJobs(request('/api/jobs'));
    const body = (await response.json()) as { jobs: Array<{ id: string }> };
    expect(body.jobs.map((job: { id: string }) => job.id)).toEqual([jobId]);
  });

  it.each([snapshot, events, report, review, delta])(
    'protects every job read endpoint',
    async (endpoint) => {
      expect(
        (await endpoint(request(`/api/jobs/${jobId}`, bob), { params: Promise.resolve({ jobId }) }))
          .status,
      ).toBe(404);
      expect(
        (
          await endpoint(request(`/api/jobs/${jobId}`, 'forged'), {
            params: Promise.resolve({ jobId }),
          })
        ).status,
      ).toBe(401);
    },
  );

  it('rejects cross-origin commands, settings edits by users and direct page access', async () => {
    expect((await guard(request('/', alice, {}, 'https://attacker.invalid')))?.status).toBe(403);
    expect((await guard(request('/', bob), undefined, true))?.status).toBe(403);
    browser.token = bob;
    await expect(requirePageUser(jobId)).rejects.toThrow('not-found');
    browser.token = 'forged';
    await expect(requirePageUser(jobId)).rejects.toThrow('login');
  });

  it('ignores a forged operator name and persists authenticated command attribution', async () => {
    const response = await command(
      request(`/api/jobs/${jobId}/commands`, alice, {
        type: 'PAUSE_JOB',
        payload: { operatorLabel: 'someone else', actorUserId: '22' },
      }),
      { params: Promise.resolve({ jobId }) },
    );
    expect(response.status).toBe(202);
    const queued = (
      (await response.json()) as { command: { id: string; payload: { operatorLabel: string } } }
    ).command;
    expect(queued.payload.operatorLabel).toBe('山田');
    h.store.completeCommand(queued.id);
    const audit = h.store.listEvents(jobId).map(buildTelemetryPayload);
    expect(audit).toHaveLength(2);
    expect(
      audit.every((event) => event.actorUserId === '11' && event.requestedByUserId === '11'),
    ).toBe(true);
    expect(JSON.stringify(audit)).not.toContain('secret-');
    const other = await command(
      request(`/api/jobs/${jobId}/commands`, bob, { type: 'PAUSE_JOB' }),
      { params: Promise.resolve({ jobId }) },
    );
    expect(other.status).toBe(404);
  });

  it('binds new jobs to the session and lets non-admins select their own templates', async () => {
    const folder = await h.gateway.ensureFolder('0', '移行先');
    h.writeSource('契約書.txt', 'contract');
    const response = await createJob(
      request('/api/jobs', alice, {
        name: '移行',
        sourceRootPath: h.sourceRoot,
        destinationFolderId: folder.id,
        operatorLabel: '偽名',
        ownerUserId: '22',
      }),
    );
    expect(response.status).toBe(201);
    const job = ((await response.json()) as { job: { id: string; operatorLabel: string } }).job;
    expect(h.store.jobOwner(job.id)).toBe('11');
    expect(job.operatorLabel).toBe('山田');
    expect(h.store.listEvents(job.id)[0]?.audit?.actorUserId).toBe('11');
    browser.token = bob;
    expect((await listTemplates(request('/api/metadata-settings', 'forged'))).status).toBe(401);
    const available = await listTemplates(request('/api/metadata-settings', bob));
    expect(available.status).toBe(200);
    const { templates } = (await available.json()) as { templates: BusinessTemplate[] };
    const created = await createJob(
      request('/api/jobs', bob, {
        name: '利用者の移行',
        sourceRootPath: h.sourceRoot,
        destinationFolderId: folder.id,
        metadataTemplates: [{ scope: templates[0]!.scope, templateKey: templates[0]!.templateKey }],
      }),
    );
    expect(created.status, JSON.stringify(await created.clone().json())).toBe(201);
    const other = ((await created.json()) as { job: { id: string } }).job;
    expect(h.store.jobOwner(other.id)).toBe('22');
    expect(h.store.getAvailableJobMetadata(other.id)).toEqual([{ template: templates[0] }]);
    expect(h.store.getMetadataSettings()).toEqual({ revision: 0, mappings: [] });
  });

  it('rejects an unbound OAuth callback without contacting Box', async () => {
    const response = await callback(
      request('/api/auth/callback?code=not-a-real-code&state=forged'),
    );
    expect(response.headers.get('location')).toContain('/login?error=oauth');
    expect(response.headers.get('location')).not.toContain('not-a-real-code');
  });

  it('revokes the application session on logout', async () => {
    expect((await logout(request('/api/auth/logout', alice, {}))).status).toBe(303);
    expect(auth.session(alice)).toBeNull();
    expect(auth.session(bob)?.id).toBe('22');
  });

  it('closes an existing progress stream after logout', async () => {
    const response = await events(request(`/api/jobs/${jobId}/events`), {
      params: Promise.resolve({ jobId }),
    });
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    auth.deleteSession(alice);
    expect((await reader.read()).done).toBe(true);
  });
});
