'use client';

import { useEffect, useRef, useState } from 'react';

type Folder = { id: string; name: string; parentFolderId: string | null };
export type SelectedBoxFolder = { folderId: string; name: string; folderCount: number };
type Listing = { folder: Folder; folders: Folder[] };

export function BoxFolderPicker({
  value,
  onChange,
  onBusyChange,
  disabled,
  boxMode,
}: {
  value: SelectedBoxFolder | null;
  onChange: (value: SelectedBoxFolder) => void;
  onBusyChange: (busy: boolean) => void;
  disabled: boolean;
  boxMode: 'real' | 'fake';
}) {
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);

  async function load(folderId: string) {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setLoading(true);
    onBusyChange(true);
    setError(null);
    try {
      const response = await fetch('/api/box-folders?folderId=' + encodeURIComponent(folderId), {
        signal: controller.signal,
      });
      const body = (await response.json()) as Listing & { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Boxフォルダーを取得できませんでした。');
      setListing(body);
    } catch (cause) {
      if (!controller.signal.aborted) setError((cause as Error).message);
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
        onBusyChange(false);
      }
    }
  }

  async function select() {
    if (!listing || loading || disabled) return;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setLoading(true);
    onBusyChange(true);
    setError(null);
    try {
      const response = await fetch('/api/box-folders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ folderId: listing.folder.id }),
        signal: controller.signal,
      });
      const body = (await response.json()) as SelectedBoxFolder & { error?: string };
      if (!response.ok) throw new Error(body.error ?? '移行先を確認できませんでした。');
      onChange(body);
      setOpen(false);
    } catch (cause) {
      if (!controller.signal.aborted) setError((cause as Error).message);
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
        onBusyChange(false);
      }
    }
  }

  return (
    <div className="source-folder" role="group" aria-labelledby="box-folder-label">
      <span id="box-folder-label" className="small">
        移行先 · {boxMode === 'real' ? 'Box' : 'Box（テスト環境）'}
      </span>
      <div className="source-folder-choice">
        <div aria-live="polite">
          <strong>{value?.name ?? 'フォルダー未選択'}</strong>
        </div>
        <button
          type="button"
          className="secondary"
          disabled={disabled || loading}
          aria-expanded={open}
          onClick={() => {
            setOpen(true);
            void load(value?.folderId ?? '0');
          }}
        >
          {value ? '変更' : 'Boxから選択'}
        </button>
      </div>
      {open ? (
        <div className="box-folder-browser">
          <div className="actions">
            <strong>
              {listing?.folder.id === '0' ? 'すべてのフォルダー' : (listing?.folder.name ?? 'Box')}
            </strong>
            {listing?.folder.parentFolderId ? (
              <button
                type="button"
                className="secondary"
                disabled={disabled || loading}
                onClick={() => void load(listing.folder.parentFolderId!)}
              >
                上の階層へ
              </button>
            ) : null}
            <button
              type="button"
              className="secondary"
              disabled={disabled || loading}
              onClick={() => void load('0')}
            >
              最上位へ
            </button>
          </div>
          {error ? (
            <p role="alert" className="error">
              {error}
            </p>
          ) : null}
          {loading ? (
            <p role="status" className="small muted">
              フォルダーを確認しています…
            </p>
          ) : null}
          <ul className="box-folder-list" aria-label="Boxのフォルダー">
            {listing?.folders.map((folder) => (
              <li key={folder.id}>
                <button
                  type="button"
                  className="secondary"
                  disabled={disabled || loading}
                  onClick={() => void load(folder.id)}
                >
                  {folder.name}
                  <span aria-hidden="true"> →</span>
                </button>
              </li>
            ))}
          </ul>
          {listing && !loading && !error && listing.folders.length === 0 ? (
            <p className="small muted">子フォルダーなし</p>
          ) : null}
          <div className="actions">
            <button
              type="button"
              className="secondary"
              disabled={disabled}
              onClick={() => {
                active.current?.abort();
                setLoading(false);
                onBusyChange(false);
                setOpen(false);
              }}
            >
              キャンセル
            </button>
            <button
              type="button"
              disabled={disabled || loading || !listing || listing.folder.id === '0'}
              onClick={() => void select()}
            >
              このフォルダーを選択
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
