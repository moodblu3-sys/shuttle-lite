'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { formatBytes } from '@shuttle-lite/core/progress';
import type { SourceListing } from '../lib/source-browser';
import type { SelectedBoxFolder } from './box-folder-picker';
import { DocumentIcon, WorkspaceIcon } from './workspace-icon';

export type SourceFolder = { cancelled: false; path: string; name: string; browseToken?: string };
type Entry = { id: string; name: string; type: 'folder' | 'file'; size?: number };
type Crumb = { id: string; name: string };
type BoxListing = {
  folder: { id: string; name: string; parentFolderId: string | null; ancestors?: Crumb[] };
  folders: { id: string; name: string }[];
  files?: Entry[];
};

function FolderPane({
  title,
  path,
  crumbs,
  entries,
  loading,
  disabled,
  error,
  onOpen,
  onRefresh,
  action,
  footer,
  ready,
}: {
  title: string;
  path: string;
  crumbs: Crumb[];
  entries: Entry[];
  loading: boolean;
  disabled: boolean;
  error: string | null;
  ready: boolean;
  onOpen: (id: string) => void;
  onRefresh: () => void;
  action?: ReactNode;
  footer: ReactNode;
}) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const filtered = entries.filter((entry) =>
    entry.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  const pages = Math.max(1, Math.ceil(filtered.length / 100));
  const currentPage = Math.min(page, pages - 1);
  useEffect(() => {
    setQuery('');
    setPage(0);
  }, [path]);
  return (
    <section className="migration-browser" aria-label={title}>
      <div className="migration-browser-heading">
        <h2>{title}</h2>
        {action}
      </div>
      <nav className="migration-browser-breadcrumb" aria-label={`${title}の階層`}>
        {crumbs.length ? (
          crumbs.map((crumb, index) => (
            <span key={crumb.id}>
              {index > 0 ? <span aria-hidden="true"> / </span> : null}
              <button
                type="button"
                className="text-button"
                disabled={disabled || loading || index === crumbs.length - 1}
                aria-current={index === crumbs.length - 1 ? 'location' : undefined}
                onClick={() => onOpen(crumb.id)}
              >
                {crumb.name}
              </button>
            </span>
          ))
        ) : (
          <span className="muted">フォルダー未選択</span>
        )}
      </nav>
      <div className="migration-browser-tools">
        <input
          type="search"
          aria-label={`${title}のフォルダー内を検索`}
          placeholder="このフォルダー内を検索"
          value={query}
          disabled={!ready || disabled || loading}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(0);
          }}
        />
        <button
          type="button"
          className="secondary"
          disabled={!ready || disabled || loading}
          onClick={onRefresh}
        >
          更新
        </button>
      </div>
      <div className="migration-browser-list" aria-busy={loading}>
        {error ? (
          <div className="migration-browser-message">
            <p className="error" role="alert">
              {error}
            </p>
            <button
              type="button"
              className="secondary"
              disabled={disabled || loading}
              onClick={onRefresh}
            >
              再読み込み
            </button>
          </div>
        ) : loading ? (
          <p className="migration-browser-message muted" role="status">
            読み込み中…
          </p>
        ) : !ready ? (
          <p className="migration-browser-message muted">フォルダーを選択してください</p>
        ) : (
          <>
            <table>
              <thead>
                <tr>
                  <th>名前</th>
                  <th>サイズ</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(currentPage * 100, (currentPage + 1) * 100).map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      {entry.type === 'folder' ? (
                        <button
                          type="button"
                          className="migration-browser-folder"
                          disabled={disabled}
                          onClick={() => onOpen(entry.id)}
                        >
                          <WorkspaceIcon kind="folder" />
                          <span>{entry.name}</span>
                          <span aria-hidden="true">›</span>
                        </button>
                      ) : (
                        <span className="migration-browser-file">
                          <DocumentIcon name={entry.name} />
                          <span>{entry.name}</span>
                        </span>
                      )}
                    </td>
                    <td>
                      {entry.type === 'file' && entry.size !== undefined
                        ? formatBytes(entry.size)
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filtered.length === 0 ? (
              <p className="migration-browser-message muted">
                {query ? '一致する項目はありません' : 'このフォルダーは空です'}
              </p>
            ) : null}
          </>
        )}
      </div>
      <div className="migration-browser-pagination">
        <span>{ready && !error && !loading ? `${filtered.length}件` : '—'}</span>
        {pages > 1 && !error && !loading ? (
          <div className="actions">
            <button
              type="button"
              className="text-button"
              disabled={disabled || currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
            >
              前へ
            </button>
            <span>
              {currentPage + 1} / {pages}
            </span>
            <button
              type="button"
              className="text-button"
              disabled={disabled || currentPage === pages - 1}
              onClick={() => setPage(currentPage + 1)}
            >
              次へ
            </button>
          </div>
        ) : null}
      </div>
      <div className="migration-browser-footer">{footer}</div>
    </section>
  );
}

export function SourceFolderPane({
  anchor,
  value,
  onChange,
  onChooseRoot,
  onBusyChange,
  disabled,
  picking,
  available,
}: {
  anchor: SourceFolder | null;
  value: SourceFolder | null;
  onChange: (folder: SourceFolder) => void;
  onChooseRoot: () => void;
  onBusyChange: (busy: boolean) => void;
  disabled: boolean;
  picking: boolean;
  available: boolean;
}) {
  const [listing, setListing] = useState<SourceListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const active = useRef<AbortController | null>(null);
  const target = useRef('');
  const load = useCallback(
    async (relativePath: string) => {
      if (!anchor?.browseToken) return;
      active.current?.abort();
      const controller = new AbortController();
      active.current = controller;
      target.current = relativePath;
      setLoading(true);
      onBusyChange(true);
      setError(null);
      try {
        const response = await fetch('/api/source-browser', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-shuttle-source-browser': '1' },
          body: JSON.stringify({ browseToken: anchor.browseToken, relativePath }),
          signal: controller.signal,
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? 'フォルダーを開けませんでした。');
        if (!controller.signal.aborted) setListing(body);
      } catch (cause) {
        if (!controller.signal.aborted) setError((cause as Error).message);
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          onBusyChange(false);
        }
      }
    },
    [anchor?.browseToken, onBusyChange],
  );
  useEffect(() => {
    void load('');
    return () => {
      active.current?.abort();
      onBusyChange(false);
    };
  }, [load, onBusyChange]);
  const parts = listing?.relativePath.split('/').filter(Boolean) ?? [];
  const crumbs = anchor
    ? [
        { id: '', name: anchor.name },
        ...parts.map((name, i) => ({ id: parts.slice(0, i + 1).join('/'), name })),
      ]
    : [];
  const selected = !!listing && value?.path === listing.path;
  return (
    <FolderPane
      title="移行元"
      path={listing?.path ?? ''}
      crumbs={crumbs}
      entries={
        listing?.entries.map((entry) => ({
          ...entry,
          id: [listing.relativePath, entry.name].filter(Boolean).join('/'),
        })) ?? []
      }
      ready={!!listing}
      loading={loading}
      disabled={disabled || picking}
      error={error}
      onOpen={(path) => void load(path)}
      onRefresh={() => void load(target.current)}
      action={
        <button
          type="button"
          className="secondary"
          disabled={disabled || picking || loading || !available}
          onClick={onChooseRoot}
        >
          {picking ? '選択中…' : anchor ? 'フォルダーを変更' : 'フォルダーを選択'}
        </button>
      }
      footer={
        <>
          <span
            className="migration-browser-path"
            title={listing?.path}
            role={!available ? 'status' : undefined}
          >
            {listing?.path ?? (!available ? 'フォルダー選択はMacのみ対応' : '未選択')}
          </span>
          <button
            type="button"
            className={selected ? 'secondary' : ''}
            disabled={disabled || picking || loading || !!error || !listing || selected}
            onClick={() =>
              listing && onChange({ cancelled: false, path: listing.path, name: listing.name })
            }
          >
            {selected ? '移行元に選択済み' : 'このフォルダーを移行元にする'}
          </button>
        </>
      }
    />
  );
}

export function BoxDestinationPane({
  value,
  onChange,
  onBusyChange,
  disabled,
}: {
  value: SelectedBoxFolder | null;
  onChange: (folder: SelectedBoxFolder) => void;
  onBusyChange: (busy: boolean) => void;
  disabled: boolean;
}) {
  const [listing, setListing] = useState<BoxListing | null>(null);
  const [crumbs, setCrumbs] = useState<Crumb[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  const target = useRef('0');
  const load = useCallback(
    async (id: string) => {
      active.current?.abort();
      const controller = new AbortController();
      active.current = controller;
      target.current = id;
      setLoading(true);
      onBusyChange(true);
      setError(null);
      try {
        const response = await fetch(
          `/api/box-folders?folderId=${encodeURIComponent(id)}&includeFiles=1`,
          { signal: controller.signal, cache: 'no-store' },
        );
        const body = (await response.json()) as BoxListing & { error?: string };
        if (!response.ok) throw new Error(body.error ?? 'Boxフォルダーを開けませんでした。');
        if (controller.signal.aborted) return;
        setListing(body);
        setCrumbs((previous) => {
          const current = {
            id: body.folder.id,
            name: body.folder.id === '0' ? 'すべてのフォルダー' : body.folder.name,
          };
          if (body.folder.ancestors)
            return [
              ...body.folder.ancestors.map((item) => ({
                ...item,
                name: item.id === '0' ? 'すべてのフォルダー' : item.name,
              })),
              current,
            ];
          const index = previous.findIndex((item) => item.id === id);
          return index >= 0 ? [...previous.slice(0, index), current] : [...previous, current];
        });
      } catch (cause) {
        if (!controller.signal.aborted) setError((cause as Error).message);
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          onBusyChange(false);
        }
      }
    },
    [onBusyChange],
  );
  useEffect(() => {
    void load('0');
    return () => {
      active.current?.abort();
      onBusyChange(false);
    };
  }, [load, onBusyChange]);
  async function select() {
    if (!listing || loading || disabled || error) return;
    const controller = new AbortController();
    active.current = controller;
    setLoading(true);
    onBusyChange(true);
    setError(null);
    try {
      const response = await fetch('/api/box-folders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ folderId: listing.folder.id, migrationMode: 'AS_IS' }),
        signal: controller.signal,
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? '移行先を選択できませんでした。');
      if (!controller.signal.aborted)
        onChange({
          ...body,
          path: crumbs
            .filter((crumb) => crumb.id !== '0')
            .map((crumb) => crumb.name)
            .join(' / '),
        });
    } catch (cause) {
      if (!controller.signal.aborted) setError((cause as Error).message);
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
        onBusyChange(false);
      }
    }
  }
  const selected = !!listing && value?.folderId === listing.folder.id;
  return (
    <FolderPane
      title="移行先 · Box"
      path={listing?.folder.id ?? ''}
      crumbs={crumbs}
      entries={[
        ...(listing?.folders.map((folder) => ({ ...folder, type: 'folder' as const })) ?? []),
        ...(listing?.files ?? []),
      ]}
      ready={!!listing}
      loading={loading}
      disabled={disabled}
      error={error}
      onOpen={(id) => void load(id)}
      onRefresh={() => void load(target.current)}
      footer={
        <>
          <span
            className="migration-browser-path"
            title={crumbs.map((item) => item.name).join(' / ')}
          >
            {crumbs.map((item) => item.name).join(' / ') || '未選択'}
          </span>
          <button
            type="button"
            className={selected ? 'secondary' : ''}
            disabled={
              disabled || loading || !!error || !listing || listing.folder.id === '0' || selected
            }
            onClick={() => void select()}
          >
            {selected ? '移行先に選択済み' : 'このフォルダーを移行先にする'}
          </button>
        </>
      }
    />
  );
}
