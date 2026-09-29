import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browseSource, grantSourceBrowse } from '../apps/web/src/lib/source-browser';
import { POST } from '../apps/web/src/app/api/source-browser/route';
import { POST as selectFolder } from '../apps/web/src/app/api/source-folder/route';
import { chooseSourceFolder } from '../apps/web/src/lib/folder-picker';
import type * as FolderPickerModule from '../apps/web/src/lib/folder-picker';

vi.mock('../apps/web/src/lib/folder-picker', async (original) => ({
  ...(await original<typeof FolderPickerModule>()),
  chooseSourceFolder: vi.fn(),
}));

const auth = vi.hoisted(() => ({ guard: vi.fn().mockResolvedValue(null) }));
vi.mock('../apps/web/src/lib/auth', () => ({
  ...auth,
  SESSION_COOKIE: 'session',
  requestCookie: () => 'user-session',
}));

describe('source folder browser', () => {
  let root: string;
  let token: string;
  beforeEach(async () => {
    auth.guard.mockResolvedValue(null);
    root = await mkdtemp(join(tmpdir(), 'shuttle-browser-'));
    await mkdir(join(root, '田中'));
    await mkdir(join(root, '田中', '契約書'));
    await writeFile(join(root, '田中', 'メモ.txt'), 'hello');
    await writeFile(join(root, '.hidden'), 'hidden');
    await writeFile(join(root, '~$契約書.docx'), 'lock');
    await symlink(tmpdir(), join(root, '外部リンク'));
    token = (await grantSourceBrowse(root, 'user-session')).browseToken;
  });
  afterEach(async () => {
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  });

  it('lists directories and file sizes without reading contents and shares worker exclusions', async () => {
    expect((await browseSource(token, '', 'user-session')).entries).toEqual([
      { name: '田中', type: 'folder' },
    ]);
    expect(await browseSource(token, '田中', 'user-session')).toMatchObject({
      path: join(root, '田中'),
      relativePath: '田中',
      name: '田中',
      entries: [
        { name: '契約書', type: 'folder' },
        { name: 'メモ.txt', type: 'file', size: 5 },
      ],
    });
    expect((await browseSource(token, '田中/契約書', 'user-session')).entries).toEqual([]);
  });
  it.each([
    '../',
    '..',
    '/tmp',
    '田中/../../',
    '外部リンク',
    '.hidden',
    '田中\\..',
    '田中/./契約書',
    '田中//契約書',
  ])('rejects paths outside the selected readable tree: %s', async (path) => {
    await expect(browseSource(token, path, 'user-session')).rejects.toThrow();
  });
  it('rejects tampering, another session and expired grants', async () => {
    await expect(browseSource(token + 'x', '', 'user-session')).rejects.toThrow();
    await expect(browseSource(token, '', 'other-session')).rejects.toThrow();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 3_600_001);
    await expect(browseSource(token, '', 'user-session')).rejects.toThrow();
  });
  it('rejects a directory replaced by a symlink after selection', async () => {
    await rm(join(root, '田中'), { recursive: true });
    await symlink(tmpdir(), join(root, '田中'));
    await expect(browseSource(token, '田中', 'user-session')).rejects.toThrow();
  });
  it('grants browsing only after native selection and does not grant it for log folders', async () => {
    vi.mocked(chooseSourceFolder).mockResolvedValue({
      cancelled: false,
      path: root,
      name: '選択フォルダー',
    });
    const pick = (query: string) =>
      selectFolder(
        new Request('http://localhost:3000/api/source-folder?' + query, {
          method: 'POST',
          headers: { origin: 'http://localhost:3000', 'x-shuttle-folder-picker': '1' },
        }),
      );
    const selected = (await (await pick('browse=1')).json()) as { browseToken: string };
    expect((await browseSource(selected.browseToken, '田中', 'user-session')).name).toBe('田中');
    expect(await (await pick('browse=1&purpose=logs')).json()).not.toHaveProperty('browseToken');
    vi.mocked(chooseSourceFolder).mockResolvedValue({ cancelled: true });
    expect(await (await pick('browse=1')).json()).toEqual({ cancelled: true });
  });
  function request(
    origin = 'http://localhost:3000',
    body = { browseToken: token, relativePath: '田中' },
  ) {
    return new Request('http://localhost:3000/api/source-browser', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', 'x-shuttle-source-browser': '1' },
      body: JSON.stringify(body),
    });
  }
  it('requires authenticated local same-origin requests and returns no-store metadata', async () => {
    auth.guard.mockResolvedValueOnce(new Response(null, { status: 401 }));
    expect((await POST(request())).status).toBe(401);
    expect((await POST(request('https://other.example'))).status).toBe(403);
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ name: '田中' });
    const denied = await POST(request(undefined, { browseToken: 'bad', relativePath: '' }));
    expect(denied.status).toBe(400);
    expect(await denied.text()).not.toContain(root);
  });
});
