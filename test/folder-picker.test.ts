import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../apps/web/src/app/api/source-folder/route';

type Completion = (error: Error | null, stdout: string) => void;
const mocks = vi.hoisted(() => ({ execFile: vi.fn(), platform: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: mocks.execFile }));
vi.mock('node:os', () => ({ platform: mocks.platform }));

function request(
  overrides: Record<string, string | undefined> = {},
  signal?: AbortSignal,
): Request {
  const headers = new Headers({
    host: 'localhost:3000',
    origin: 'http://localhost:3000',
    'x-shuttle-folder-picker': '1',
    'sec-fetch-site': 'same-origin',
  });
  for (const [name, value] of Object.entries(overrides)) {
    if (value !== undefined) headers.set(name, value);
  }
  return new Request('http://localhost:3000/api/source-folder', {
    method: 'POST',
    headers,
    signal,
  });
}

function result(output: string) {
  mocks.execFile.mockImplementation(
    (_file: string, _args: string[], _options: unknown, done: Completion) => done(null, output),
  );
}

describe('local Mac folder selection', () => {
  beforeEach(() => {
    mocks.execFile.mockReset();
    mocks.platform.mockReturnValue('darwin');
  });
  afterEach(() => vi.restoreAllMocks());

  it('returns a chosen Unicode path intact and never inserts it into a shell command', async () => {
    const path = "/Users/demo/営業部 の資料 '見積' $(no-command)/";
    result(`selected:${path}\n`);
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      cancelled: false,
      path,
      name: "営業部 の資料 '見積' $(no-command)",
    });
    expect(mocks.execFile).toHaveBeenCalledOnce();
    const [program, args, options] = mocks.execFile.mock.calls[0]!;
    expect(program).toBe('/usr/bin/osascript');
    expect(args[0]).toBe('-e');
    expect(args[1]).toContain('choose folder');
    expect(args[1]).not.toContain(path);
    expect(options).toMatchObject({ shell: false, encoding: 'utf8', timeout: 180_000 });
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('treats cancelling as a normal result without inventing a path', async () => {
    result('cancelled\n');
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cancelled: true });
  });

  it.each(['selected:relative/path\n', 'selected:/bad\0path\n', 'unexpected\n'])(
    'rejects an invalid native response: %s',
    async (output) => {
      result(output);
      expect((await POST(request())).status).toBe(500);
    },
  );

  it('does not expose native error output and allows another attempt after failure', async () => {
    mocks.execFile.mockImplementationOnce(
      (_file: string, _args: string[], _options: unknown, done: Completion) =>
        done(new Error('private local path or native diagnostic'), ''),
    );
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('private local path');
    result('cancelled\n');
    expect((await POST(request())).status).toBe(200);
  });

  it('opens only one dialog at a time, including requests from another tab', async () => {
    let finish!: Completion;
    mocks.execFile.mockImplementationOnce(
      (_file: string, _args: string[], _options: unknown, done: Completion) => {
        finish = done;
      },
    );
    const first = POST(request());
    expect((await POST(request())).status).toBe(409);
    expect(mocks.execFile).toHaveBeenCalledOnce();
    finish(null, 'cancelled\n');
    expect((await first).status).toBe(200);
    result('selected:/Users/demo/Documents/\n');
    expect((await POST(request())).status).toBe(200);
  });

  it('passes cancellation to the native process and releases the dialog lock', async () => {
    const controller = new AbortController();
    mocks.execFile.mockImplementationOnce(
      (_file: string, _args: string[], options: { signal: AbortSignal }, done: Completion) => {
        options.signal.addEventListener('abort', () => done(new Error('aborted'), ''));
      },
    );
    const pending = POST(request({}, controller.signal));
    controller.abort();
    expect(await (await pending).json()).toEqual({ cancelled: true });
    result('cancelled\n');
    expect((await POST(request())).status).toBe(200);
  });

  it('does not open a dialog for an already-aborted request', async () => {
    const controller = new AbortController();
    controller.abort();
    const response = await POST(request({}, controller.signal));
    expect(await response.json()).toEqual({ cancelled: true });
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it.each(['linux', 'win32'])('explains that %s cannot open the Mac dialog', async (platform) => {
    mocks.platform.mockReturnValue(platform);
    const response = await POST(request());
    expect(response.status).toBe(501);
    expect(((await response.json()) as { error: string }).error).toContain('Mac');
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it.each([
    { origin: 'https://other.example' },
    { origin: 'http://localhost:4000' },
    { origin: 'null' },
    { origin: '' },
    { host: 'other.example', origin: 'http://other.example' },
    { host: '192.168.1.2:3000', origin: 'http://192.168.1.2:3000' },
    { 'x-shuttle-folder-picker': '' },
    { 'sec-fetch-site': 'cross-site' },
  ])('rejects a non-local or cross-origin dialog request: %j', async (headers) => {
    const response = await POST(request(headers));
    expect(response.status).toBe(403);
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it.each(['127.0.0.1:3000', '[::1]:3000'])(
    'accepts the same-origin loopback address %s',
    async (host) => {
      result('cancelled\n');
      expect((await POST(request({ host, origin: `http://${host}` }))).status).toBe(200);
    },
  );
});
