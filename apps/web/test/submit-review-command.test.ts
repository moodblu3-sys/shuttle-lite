import { afterEach, expect, it, vi } from 'vitest';
import { submitReviewCommand } from '../src/lib/submit-review-command';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('retries a known database rejection and returns the accepted command', async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ code: 'DATABASE_BUSY' }, { status: 503 }))
    .mockResolvedValueOnce(Response.json({ command: { id: 'accepted', state: 'PENDING' } }));
  vi.stubGlobal('fetch', fetcher);
  const promise = submitReviewCommand('job', { type: 'APPROVE_ITEM' });
  await vi.runAllTimersAsync();
  expect(await promise).toMatchObject({ id: 'accepted' });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it.each([200, 500])('does not replay an empty response with status %s', async (status) => {
  const fetcher = vi.fn().mockResolvedValue(new Response('', { status }));
  vi.stubGlobal('fetch', fetcher);
  await expect(submitReviewCommand('job', {})).rejects.toThrow('受付結果を確認できません');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
