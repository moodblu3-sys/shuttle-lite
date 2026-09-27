import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildConfig, parseEnv } from '@shuttle-lite/config';
import { SnowflakeTelemetrySink } from '@shuttle-lite/telemetry';
import { POST } from '../apps/web/src/app/api/settings/snowflake/route';
import { getConfig, getStore } from '../apps/web/src/lib/runtime';

vi.mock('../apps/web/src/lib/runtime', () => ({ getConfig: vi.fn(), getStore: vi.fn() }));
const config = buildConfig(parseEnv({ BOX_MODE: 'fake' } as NodeJS.ProcessEnv));
function request(revision = 3, origin = 'http://localhost') {
  return new Request('http://localhost/api/settings/snowflake', {
    method: 'POST',
    headers: { origin, 'x-shuttle-settings': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ revision }),
  });
}
function setup(sink: 'jsonl' | 'snowflake' = 'snowflake') {
  vi.mocked(getConfig).mockReturnValue({ ...config, telemetry: { ...config.telemetry, sink } });
  vi.mocked(getStore).mockReturnValue({ getRuntimeSettings: () => ({ revision: 3 }) } as ReturnType<
    typeof getStore
  >);
  const deliver = vi.spyOn(SnowflakeTelemetrySink.prototype, 'deliver').mockResolvedValue();
  const close = vi.spyOn(SnowflakeTelemetrySink.prototype, 'close').mockResolvedValue();
  return { deliver, close };
}
afterEach(() => vi.restoreAllMocks());

describe('Snowflake connection test', () => {
  it('writes only a synthetic record with saved settings and returns its identifier', async () => {
    const { deliver, close } = setup();
    const response = await POST(request());
    expect(response.status).toBe(200);
    const result = (await response.json()) as { eventId: string; checkedAt: string };
    expect(result.eventId).toMatch(/^connection-test-/);
    expect(deliver).toHaveBeenCalledWith([
      {
        eventId: result.eventId,
        jobId: 'connection-test',
        payload: {
          eventId: result.eventId,
          jobId: 'connection-test',
          phase: 'CONNECTION_TEST',
          status: 'SUCCEEDED',
          occurredAt: result.checkedAt,
        },
      },
    ]);
    expect(close).toHaveBeenCalledOnce();
  });
  it('rejects foreign origins, stale settings and local-only logging without network calls', async () => {
    const { deliver } = setup();
    expect((await POST(request(3, 'https://example.org'))).status).toBe(403);
    expect((await POST(request(2))).status).toBe(409);
    vi.mocked(getConfig).mockReturnValue(config);
    expect((await POST(request())).status).toBe(400);
    expect(deliver).not.toHaveBeenCalled();
  });
  it('does not expose sensitive errors and releases the connection after failures', async () => {
    const { deliver, close } = setup();
    deliver.mockRejectedValueOnce(new Error('private-secret-and-sql'));
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('private-secret');
    expect(close).toHaveBeenCalledOnce();
    expect((await POST(request())).status).toBe(200);
  });
  it('blocks concurrent connection tests', async () => {
    const { deliver } = setup();
    let finish!: () => void;
    deliver.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const first = POST(request());
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
    expect((await POST(request())).status).toBe(409);
    finish();
    expect((await first).status).toBe(200);
  });
});
