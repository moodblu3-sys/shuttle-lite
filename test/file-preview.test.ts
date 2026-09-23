import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoxGateway } from '@shuttle-lite/box';
import { ShuttleError, type MigrationItem } from '@shuttle-lite/core';
import { POST } from '../apps/web/src/app/api/jobs/[jobId]/items/[itemId]/preview/route';
import { validatePreviewUrl } from '../apps/web/src/lib/file-preview';
import { getBoxGateway, getStore } from '../apps/web/src/lib/runtime';
import { createHarness, runUntilIdle, type Harness } from './harness';

vi.mock('../apps/web/src/lib/runtime', () => ({ getBoxGateway: vi.fn(), getStore: vi.fn() }));

describe('review preview API', () => {
  let h: Harness;
  let item: MigrationItem;
  const preview = vi.fn<BoxGateway['getFilePreview']>();
  const rawUrl = 'https://cloud.app.box.com/preview/expiring_embed/test-only';
  beforeEach(async () => {
    h = await createHarness();
    h.writeSource('契約書.txt', '業務委託契約書 契約番号 LEG-2026-0042 甲乙は契約を締結する。');
    const profile = h.createProfile();
    const job = h.store.createJob({
      profileId: profile.id,
      operatorLabel: '担当者',
      testMode: true,
    });
    h.store.enqueueCommand(job.id, 'START_JOB');
    await runUntilIdle(h);
    item = h.store.listItems(job.id)[0]!;
    preview.mockReset();
    preview.mockResolvedValue({
      fileId: item.boxFileId!,
      versionId: item.boxFileVersionId!,
      sha1: item.boxSha1!,
      url: rawUrl,
    });
    vi.mocked(getStore).mockReturnValue(h.store);
    vi.mocked(getBoxGateway).mockReturnValue({
      kind: 'http',
      getFilePreview: preview,
    } as unknown as BoxGateway);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    h.cleanup();
  });

  function request(
    body: unknown = {
      observedBoxFileId: item.boxFileId,
      observedBoxVersionId: item.boxFileVersionId,
      observedBoxSha1: item.boxSha1,
    },
  ) {
    return new Request('http://localhost/api/preview', {
      method: 'POST',
      headers: {
        origin: 'http://localhost',
        'x-shuttle-preview': '1',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }
  function call(input = request(), jobId = item.jobId, itemId = item.id) {
    return POST(input, { params: Promise.resolve({ jobId, itemId }) });
  }
  it('issues a fresh non-cacheable preview without changing approval or metadata state', async () => {
    const before = h.store.getItem(item.id);
    const routing = h.store.getRouting(item.id);
    const commands = h.store.listCommands(item.jobId);
    for (let i = 0; i < 2; i++) {
      const result = await call();
      expect(result.status).toBe(200);
      expect(result.headers.get('cache-control')).toBe('no-store');
      expect(await result.json()).toEqual({
        fileId: item.boxFileId,
        versionId: item.boxFileVersionId,
        sha1: item.boxSha1,
        url: `${rawUrl}?showDownload=false&showAnnotations=false`,
      });
    }
    expect(preview).toHaveBeenCalledTimes(2);
    expect(h.store.getItem(item.id)).toEqual(before);
    expect(h.store.getRouting(item.id)).toEqual(routing);
    expect(h.store.listCommands(item.jobId)).toEqual(commands);
  });
  it('rejects cross-origin requests and missing dedicated headers', async () => {
    const input = request();
    input.headers.set('origin', 'https://other.invalid');
    const result = await call(input);
    expect(result.status).toBe(403);
    expect(result.headers.get('cache-control')).toBe('no-store');
    const noHeader = request();
    noHeader.headers.delete('x-shuttle-preview');
    expect((await call(noHeader)).status).toBe(403);
    expect(preview).not.toHaveBeenCalled();
  });
  it('rejects another job or missing item before contacting Box', async () => {
    const other = h.store.createJob({
      profileId: h.store.getJob(item.jobId)!.profileId,
      operatorLabel: 'other',
    });
    expect((await call(request(), other.id)).status).toBe(404);
    expect((await call(request(), item.jobId, 'missing')).status).toBe(404);
    expect(preview).not.toHaveBeenCalled();
  });
  it('rejects incomplete input and stale observations', async () => {
    expect((await call(request({}))).status).toBe(400);
    expect(
      (
        await call(
          request({
            observedBoxFileId: 'another-file',
            observedBoxVersionId: item.boxFileVersionId,
            observedBoxSha1: item.boxSha1,
          }),
        )
      ).status,
    ).toBe(409);
    expect(preview).not.toHaveBeenCalled();
  });
  it.each(['boxFileId', 'boxFileVersionId', 'boxSha1'] as const)(
    'rejects missing %s before contacting Box',
    async (field) => {
      h.store.updateItem(item.id, { [field]: null });
      expect((await call()).status).toBe(409);
      expect(preview).not.toHaveBeenCalled();
    },
  );
  it('rejects completed or cleaning-up jobs', async () => {
    h.store.updateItem(item.id, { state: 'COMPLETED' });
    expect((await call()).status).toBe(409);
    h.store.updateItem(item.id, { state: item.state });
    h.store.requestTestCleanup(item.jobId);
    expect((await call()).status).toBe(409);
    expect(preview).not.toHaveBeenCalled();
  });
  it.each(['versionId', 'sha1', 'fileId'] as const)('rejects a changed Box %s', async (field) => {
    preview.mockResolvedValue({
      fileId: item.boxFileId!,
      versionId: item.boxFileVersionId!,
      sha1: item.boxSha1!,
      url: rawUrl,
      [field]: 'changed',
    });
    expect((await call()).status).toBe(409);
  });
  it('checks cleanup again after the Box request', async () => {
    preview.mockImplementationOnce(async () => {
      h.store.requestTestCleanup(item.jobId);
      return {
        fileId: item.boxFileId!,
        versionId: item.boxFileVersionId!,
        sha1: item.boxSha1!,
        url: rawUrl,
      };
    });
    expect((await call()).status).toBe(409);
  });
  it('checks item replacement again after the Box request', async () => {
    preview.mockImplementationOnce(async () => {
      h.store.updateItem(item.id, { boxFileId: 'replacement' });
      return {
        fileId: item.boxFileId!,
        versionId: item.boxFileVersionId!,
        sha1: item.boxSha1!,
        url: rawUrl,
      };
    });
    expect((await call()).status).toBe(409);
  });
  it('handles a removed file and the fake gateway', async () => {
    preview.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
    vi.mocked(getBoxGateway).mockReturnValue(h.gateway);
    expect((await call()).status).toBe(409);
    await expect(h.gateway.getFilePreview(item.boxFileId!)).rejects.toThrow('デモモード');
  });
  it.each([
    ['BOX_AUTH', 502],
    ['BOX_PERMISSION', 502],
    ['BOX_NOT_FOUND', 404],
    ['BOX_TIMEOUT', 504],
    ['BOX_RATE_LIMIT', 429],
    ['UNKNOWN', 502],
  ] as const)('sanitizes %s errors', async (category, status) => {
    preview.mockRejectedValue(
      new ShuttleError(category, 'secret-token-and-url', { retryAfterMs: 12000 }),
    );
    const result = await call();
    expect(result.status).toBe(status);
    expect(result.headers.get('cache-control')).toBe('no-store');
    if (status === 429) expect(result.headers.get('retry-after')).toBe('12');
    expect(await result.text()).not.toContain('secret-token-and-url');
  });
});

describe('preview URL validation', () => {
  it.each([
    'http://app.box.com/preview/expiring_embed/x',
    'https://app.box.com.evil.invalid/preview/expiring_embed/x',
    'https://evilapp.box.com/preview/expiring_embed/x',
    'https://user:password@app.box.com/preview/expiring_embed/x',
    'https://app.box.com:444/preview/expiring_embed/x',
    'https://app.box.com/preview/expiring_embed/',
    'https://app.box.com/file/123',
    'javascript:alert(1)',
  ])('rejects %s', (url) => {
    expect(() => validatePreviewUrl(url)).toThrow();
  });
  it.each(['app.box.com', 'cloud.app.box.com', 'example.app.box.com'])('accepts %s', (host) => {
    expect(validatePreviewUrl(`https://${host}/preview/expiring_embed/x?showDownload=true`)).toBe(
      `https://${host}/preview/expiring_embed/x?showDownload=false&showAnnotations=false`,
    );
  });
});
