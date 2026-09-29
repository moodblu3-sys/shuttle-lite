// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewJobForm } from '../src/components/new-job-form';

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

describe('direct migration with two folder panes', () => {
  let root: Root;
  let container: HTMLDivElement;
  let sourceFailure = false;
  let boxFailure = false;
  let previewPaths: string[];
  const fetchMock = vi.fn<typeof fetch>();
  const signature = 'a'.repeat(64);
  const sourcePath = '/Users/demo/担当者の作業フォルダー';
  const boxRoot = {
    folder: { id: '0', name: 'すべて', parentFolderId: null },
    folders: [{ id: '123', name: 'ABCプロジェクト' }],
    files: [],
  };
  beforeEach(async () => {
    sourceFailure = false;
    boxFailure = false;
    previewPaths = [];
    router.push.mockReset();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url, init) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      if (String(url).startsWith('/api/source-folder'))
        return Response.json({
          cancelled: false,
          path: sourcePath,
          name: '担当者の作業フォルダー',
          browseToken: 'test-grant',
        });
      if (url === '/api/source-browser') {
        if (sourceFailure)
          return Response.json({ error: 'フォルダーを開けません' }, { status: 400 });
        const child = body.relativePath === '田中';
        return Response.json({
          path: child ? sourcePath + '/田中' : sourcePath,
          name: child ? '田中' : '担当者の作業フォルダー',
          relativePath: body.relativePath,
          entries: child
            ? [{ name: '契約書.pdf', type: 'file', size: 1024 }]
            : [
                { name: '田中', type: 'folder' },
                ...Array.from({ length: 101 }, (_, i) => ({
                  name: `見積書${i}.pdf`,
                  type: 'file',
                  size: 100,
                })),
              ],
        });
      }
      if (String(url).startsWith('/api/box-folders?')) {
        if (boxFailure) return Response.json({ error: 'Boxを開けません' }, { status: 400 });
        return Response.json(
          String(url).includes('folderId=0')
            ? boxRoot
            : {
                folder: { id: '123', name: 'ABCプロジェクト', parentFolderId: '0' },
                folders: [],
                files: [{ id: 'f1', name: '既存の議事録.pdf', type: 'file', size: 2048 }],
              },
        );
      }
      if (url === '/api/box-folders')
        return Response.json({ folderId: body.folderId, name: 'ABCプロジェクト', folderCount: 1 });
      if (url === '/api/source-check') {
        previewPaths.push(body.sourceRootPath);
        return Response.json({
          fileCount: 1,
          folderCount: 0,
          totalBytes: 1024,
          errorCount: 0,
          excludedCount: 0,
          errors: [],
          complete: true,
          signature,
          checkedAt: '2026-09-29',
        });
      }
      if (url === '/api/jobs') return Response.json({ job: { id: 'new-job' } });
      throw new Error('Unexpected URL: ' + url);
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root.render(
        createElement(NewJobForm, {
          aiEnabled: true,
          boxMode: 'real',
          authenticated: true,
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
  function button(name: string, scope: ParentNode = container) {
    const result = [...scope.querySelectorAll('button')].find(
      (node) => node.textContent?.trim() === name,
    );
    expect(result, name).toBeDefined();
    return result!;
  }
  async function click(name: string, scope?: ParentNode) {
    await act(async () => button(name, scope).click());
  }
  async function direct() {
    await act(async () => container.querySelector<HTMLInputElement>('[value=AS_IS]')!.click());
  }
  function source() {
    return container.querySelector('section[aria-label="移行元"]')!;
  }
  function box() {
    return container.querySelector('section[aria-label="移行先 · Box"]')!;
  }

  it('browses both sides, selects a child source, checks it, and submits the existing AS_IS contract', async () => {
    expect(container.querySelector('.migration-dual-pane')).toBeNull();
    await direct();
    expect(button('このフォルダーを移行先にする', box()).disabled).toBe(true);
    await click('フォルダーを選択');
    expect(source().textContent).toContain('102件');
    expect(source().querySelectorAll('tbody tr')).toHaveLength(100);
    await click('次へ', source());
    expect(source().querySelectorAll('tbody tr')).toHaveLength(2);
    await click('前へ', source());
    await click('田中›', source());
    expect(source().textContent).toContain('契約書.pdf');
    expect(source().textContent).toContain('1.00 KB');
    // 閲覧だけでは移行元は変わらず、選択確定して初めて反映する。
    expect(container.querySelector('.migration-path-summary')?.textContent).not.toContain('/田中');
    await click('このフォルダーを移行元にする');
    await click('ABCプロジェクト›', box());
    expect(box().textContent).toContain('既存の議事録.pdf');
    await click('このフォルダーを移行先にする');
    expect(container.querySelector('.migration-path-summary')?.textContent).toContain(
      'ABCプロジェクト / 田中',
    );
    expect(button('移行を開始').disabled).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/jobs')).toBe(false);
    await click('移行元を確認');
    expect(previewPaths).toEqual([sourcePath + '/田中']);
    container.querySelector<HTMLInputElement>('[name=name]')!.value = '田中の資料';
    await act(async () =>
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(JSON.parse(fetchMock.mock.calls.at(-1)![1]!.body as string)).toMatchObject({
      migrationMode: 'AS_IS',
      sourceRootPath: sourcePath + '/田中',
      destinationFolderId: '123',
      sourceCheck: signature,
      aiRoutingEnabled: false,
      metadataTemplates: [],
      conflictPolicy: 'RENAME',
    });
    expect(router.push).toHaveBeenCalledWith('/jobs/new-job');
  });
  it('invalidates source checks only when a different folder is selected and supports breadcrumbs', async () => {
    await direct();
    await click('フォルダーを選択');
    await click('移行元を確認');
    await click('田中›', source());
    expect(container.querySelector('.source-check')?.textContent).toContain('確認済み');
    await click('このフォルダーを移行元にする');
    expect(container.querySelector('.source-check')?.textContent).toContain('未確認');
    await click('担当者の作業フォルダー', source());
    expect(source().textContent).toContain('見積書0.pdf');
    expect(container.querySelector('.migration-path-summary')?.textContent).toContain('/田中');
  });
  it('filters the whole current folder and prevents selecting stale results after a failure', async () => {
    await direct();
    await click('フォルダーを選択');
    const input = source().querySelector<HTMLInputElement>('input[type=search]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        '見積書100',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(source().querySelectorAll('tbody tr')).toHaveLength(1);
    expect(source().textContent).toContain('見積書100.pdf');
    sourceFailure = true;
    await click('更新', source());
    expect(source().querySelector('[role=alert]')?.textContent).toContain('開けません');
    expect(source().querySelector('tbody')).toBeNull();
    expect(button('移行元に選択済み', source()).disabled).toBe(true);
    sourceFailure = false;
    await click('再読み込み', source());
    expect(source().querySelector('[role=alert]')).toBeNull();
    await click('ABCプロジェクト›', box());
    boxFailure = true;
    await click('更新', box());
    expect(button('このフォルダーを移行先にする', box()).disabled).toBe(true);
  });
  it('keeps the AI form and classic fallback available', async () => {
    await direct();
    await act(async () =>
      container.querySelector<HTMLInputElement>('[value=AI_ORGANIZE]')!.click(),
    );
    expect(container.querySelector('.migration-dual-pane')).toBeNull();
    expect(button('Boxから選択')).toBeDefined();
    await act(async () =>
      root.render(
        createElement(NewJobForm, {
          aiEnabled: true,
          boxMode: 'real',
          folderPickerAvailable: true,
          classicFolderPicker: true,
        }),
      ),
    );
    await direct();
    expect(container.querySelector('.migration-dual-pane')).toBeNull();
    expect(button('Boxから選択')).toBeDefined();
  });
});
