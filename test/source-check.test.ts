import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, open: vi.fn(actual.open) };
});
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkSource } from '../apps/web/src/lib/source-check';
import { POST } from '../apps/web/src/app/api/source-check/route';
import { LocalSourceAdapter } from '../apps/worker/src/source/local';

describe('read-only source preview', () => {
  let root: string;
  beforeEach(async () => {
    const actual = await vi.importActual<typeof fs>('node:fs/promises');
    vi.mocked(fs.open).mockImplementation(actual.open);
    root = await mkdtemp(join(tmpdir(), 'shuttle-preview-'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(fs.open).mockReset();
    await rm(root, { recursive: true, force: true });
  });

  it('matches worker exclusions and counts nested files, bytes and empty folders', async () => {
    await mkdir(join(root, '契約書'));
    await mkdir(join(root, '空'));
    await mkdir(join(root, '.hidden'));
    await writeFile(join(root, '.hidden', 'hidden.txt'), 'hidden');
    await writeFile(join(root, '契約書', 'A社.txt'), 'abc');
    await writeFile(join(root, '請求書.txt'), '12345');
    for (const name of ['.DS_Store', 'Thumbs.db', '~$メモ.docx'])
      await writeFile(join(root, name), 'ignore');
    await symlink(join(root, '契約書'), join(root, 'リンク'));
    const preview = await checkSource(root);
    expect(preview).toMatchObject({
      fileCount: 2,
      folderCount: 2,
      totalBytes: 8,
      excludedCount: 5,
      errorCount: 0,
      complete: true,
    });
    const adapter = new LocalSourceAdapter({ rootPath: root });
    const files = [];
    for await (const item of adapter.scan()) files.push(item);
    expect(files).toHaveLength(preview.fileCount);
    expect(files.reduce((sum, item) => sum + item.size, 0)).toBe(preview.totalBytes);
    const folders = [];
    for await (const path of adapter.scanDirectories()) folders.push(path);
    expect(folders.length - 1).toBe(preview.folderCount);
    expect((await checkSource(root)).signature).toBe(preview.signature);
    await writeFile(join(root, '請求書.txt'), 'changed');
    expect((await checkSource(root)).signature).not.toBe(preview.signature);
  });

  it('reports unreadable files without exposing low-level errors or issuing a signature', async () => {
    await writeFile(join(root, 'locked.txt'), 'sample');
    vi.mocked(fs.open).mockRejectedValue(
      Object.assign(new Error('private detail'), { code: 'EACCES' }),
    );
    const result = await checkSource(root);
    expect(result).toMatchObject({ errorCount: 1, fileCount: 0, signature: null });
    expect(result.errors[0]?.path).toBe('locked.txt');
    expect(JSON.stringify(result)).not.toContain('private detail');
  });

  it('does not approve missing, cancelled or truncated inventories', async () => {
    expect(await checkSource(join(root, 'missing'))).toMatchObject({
      errorCount: 1,
      signature: null,
    });
    const controller = new AbortController();
    controller.abort();
    expect(await checkSource(root, controller.signal)).toMatchObject({
      complete: false,
      signature: null,
    });
    await writeFile(join(root, 'file.txt'), 'sample');
    expect(await checkSource(root, undefined, { entries: 1, durationMs: 60000 })).toMatchObject({
      complete: false,
      signature: null,
      errorCount: 1,
    });
  });

  it('accepts only a local same-origin preview request and returns no-store results', async () => {
    const request = (origin: string, path = root) =>
      new Request('http://localhost/api/source-check', {
        method: 'POST',
        headers: { origin, 'x-shuttle-source-check': '1', 'content-type': 'application/json' },
        body: JSON.stringify({ sourceRootPath: path }),
      });
    expect((await POST(request('https://other.example'))).status).toBe(403);
    expect((await POST(request('http://localhost', 'relative'))).status).toBe(400);
    const response = await POST(request('http://localhost'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ complete: true, fileCount: 0, errorCount: 0 });
  });
});
