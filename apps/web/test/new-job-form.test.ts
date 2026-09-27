// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewJobForm } from '../src/components/new-job-form';

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

describe('migration mode selection', () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    router.push.mockReset();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root.render(
        createElement(NewJobForm, {
          aiEnabled: true,
          boxMode: 'real',
          folderPickerAvailable: true,
        }),
      ),
    );
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  async function click(text: string) {
    const button = [...container.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === text,
    );
    expect(button).toBeDefined();
    await act(async () => button!.click());
  }
  async function mode(value: string) {
    await act(async () => {
      container.querySelector<HTMLInputElement>(`[name=migrationMode][value="${value}"]`)!.click();
    });
  }

  async function selectFolders() {
    fetchMock.mockResolvedValueOnce(
      Response.json({ cancelled: false, path: '/Users/demo/営業資料', name: '営業資料' }),
    );
    await click('フォルダーを選択');
    fetchMock.mockResolvedValueOnce(
      Response.json({
        folder: { id: '0', name: 'すべて', parentFolderId: null },
        folders: [{ id: '123', name: '移行データ', parentFolderId: '0' }],
      }),
    );
    await click('Boxから選択');
    fetchMock.mockResolvedValueOnce(
      Response.json({
        folder: { id: '123', name: '移行データ', parentFolderId: '0' },
        folders: [],
      }),
    );
    await click('移行データ →');
    fetchMock.mockResolvedValueOnce(
      Response.json({ folderId: '123', name: '移行データ', folderCount: 1 }),
    );
    await click('このフォルダーを選択');
  }

  it('submits a preserve job, omits the AI option and validates only the selected Box root', async () => {
    expect(container.querySelector('[name=aiRoutingEnabled]')).not.toBeNull();
    await mode('AS_IS');
    expect(container.querySelector('[name=aiRoutingEnabled]')).toBeNull();
    await selectFolders();
    expect(JSON.parse(fetchMock.mock.calls.at(-1)![1]!.body as string)).toEqual({
      folderId: '123',
      migrationMode: 'AS_IS',
    });
    container.querySelector<HTMLInputElement>('[name=name]')!.value = '営業資料の移行';
    expect(container.textContent).toContain('移行データ / 営業資料');
    expect(container.textContent).toContain('初回の同名ファイル');
    expect(
      [...container.querySelectorAll('button')].find((b) => b.textContent === '移行を開始')!
        .disabled,
    ).toBe(true);
    fetchMock.mockResolvedValueOnce(
      Response.json({
        fileCount: 2,
        folderCount: 1,
        totalBytes: 1024,
        excludedCount: 0,
        errorCount: 0,
        errors: [],
        complete: true,
        signature: 'a'.repeat(64),
        checkedAt: '2026-09-27',
      }),
    );
    await click('移行元を確認');
    fetchMock.mockResolvedValueOnce(Response.json({ job: { id: 'job_new' } }));
    await act(async () =>
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(JSON.parse(fetchMock.mock.calls.at(-1)![1]!.body as string)).toMatchObject({
      sourceCheck: 'a'.repeat(64),
      migrationMode: 'AS_IS',
      aiRoutingEnabled: false,
      sourceRootPath: '/Users/demo/営業資料',
      destinationFolderId: '123',
      autoStart: true,
    });
    expect(router.push).toHaveBeenCalledWith('/jobs/job_new');
  });

  it('defaults to AI and keeps an unreadable source from starting', async () => {
    expect(
      container.querySelector<HTMLInputElement>('[name=migrationMode][value=AI_ORGANIZE]')?.checked,
    ).toBe(true);
    await selectFolders();
    fetchMock.mockResolvedValueOnce(
      Response.json({
        fileCount: 1,
        folderCount: 0,
        totalBytes: 12,
        excludedCount: 0,
        errorCount: 1,
        errors: [{ path: 'メモ.txt', message: '読み取れません。' }],
        complete: true,
        signature: null,
        checkedAt: '2026-09-27',
      }),
    );
    await click('移行元を確認');
    expect(container.textContent).toContain('メモ.txt：読み取れません。');
    expect(container.textContent).toContain('読み取れた分のみ');
    await act(async () =>
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/jobs')).toBe(false);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('invalidates a successful preview after the selected source changes', async () => {
    await selectFolders();
    fetchMock.mockResolvedValueOnce(
      Response.json({
        fileCount: 1,
        folderCount: 0,
        totalBytes: 12,
        excludedCount: 0,
        errorCount: 0,
        errors: [],
        complete: true,
        signature: 'a'.repeat(64),
        checkedAt: '2026-09-27',
      }),
    );
    await click('移行元を確認');
    expect(
      [...container.querySelectorAll('button')].find((b) => b.textContent === '移行を開始')
        ?.disabled,
    ).toBe(false);
    fetchMock.mockResolvedValueOnce(
      Response.json({ cancelled: false, path: '/Users/demo/別の資料', name: '別の資料' }),
    );
    await click('変更');
    expect(container.querySelector('.source-check')?.textContent).toContain('未確認');
    expect(
      [...container.querySelectorAll('button')].find((b) => b.textContent === '移行を開始')
        ?.disabled,
    ).toBe(true);
  });

  it('requires another preview when the start endpoint detects a source change', async () => {
    await selectFolders();
    fetchMock.mockResolvedValueOnce(
      Response.json({
        fileCount: 1,
        folderCount: 0,
        totalBytes: 12,
        excludedCount: 0,
        errorCount: 0,
        errors: [],
        complete: true,
        signature: 'a'.repeat(64),
        checkedAt: '2026-09-27',
      }),
    );
    await click('移行元を確認');
    fetchMock.mockResolvedValueOnce(
      Response.json({ error: '再確認してください。', sourceChanged: true }, { status: 409 }),
    );
    await act(async () =>
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(container.querySelector('.source-check')?.textContent).toContain('未確認');
    expect(router.push).not.toHaveBeenCalled();
  });

  it('restores the existing AI option when switching back', async () => {
    await mode('AS_IS');
    await mode('AI_ORGANIZE');
    expect(container.querySelector<HTMLInputElement>('[name=aiRoutingEnabled]')?.checked).toBe(
      true,
    );
  });
});
