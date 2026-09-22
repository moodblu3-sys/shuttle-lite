'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { BoxFolderPicker, type SelectedBoxFolder } from './box-folder-picker';
import type { FolderSelection } from '../lib/folder-picker';

export function NewJobForm({
  aiEnabled,
  boxMode,
  folderPickerAvailable,
}: {
  aiEnabled: boolean;
  boxMode: 'real' | 'fake';
  folderPickerAvailable: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [testMode, setTestMode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [folder, setFolder] = useState<Extract<FolderSelection, { cancelled: false }> | null>(null);
  const [destination, setDestination] = useState<SelectedBoxFolder | null>(null);
  const [selectingDestination, setSelectingDestination] = useState(false);
  const [picking, setPicking] = useState(false);
  const pickerRequest = useRef<AbortController | null>(null);

  useEffect(() => () => pickerRequest.current?.abort(), []);

  async function selectFolder() {
    if (pickerRequest.current || busy) return;
    const controller = new AbortController();
    pickerRequest.current = controller;
    setPicking(true);
    setError(null);
    try {
      const response = await fetch('/api/source-folder', {
        method: 'POST',
        headers: { 'x-shuttle-folder-picker': '1' },
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error ?? 'フォルダーを選択できませんでした。');
      }
      const selection = (await response.json()) as FolderSelection;
      if (!selection.cancelled) setFolder(selection);
    } catch (cause) {
      if (!controller.signal.aborted) setError((cause as Error).message);
    } finally {
      pickerRequest.current = null;
      if (!controller.signal.aborted) setPicking(false);
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || picking || selectingDestination) return;
    if (!folder) {
      setError('移行元フォルダーを選択してください。');
      return;
    }
    if (!destination) {
      setError('Boxの移行先フォルダーを選択してください。');
      return;
    }
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: form.get('name'),
          sourceRootPath: folder.path,
          destinationFolderId: destination.folderId,
          operatorLabel: form.get('operatorLabel'),
          aiRoutingEnabled: aiEnabled && form.get('aiRoutingEnabled') === 'on',
          conflictPolicy: form.get('conflictPolicy'),
          autoStart: true,
          testMode,
        }),
      });
      const body = (await response.json()) as { job?: { id: string }; error?: string };
      if (!response.ok || !body.job) throw new Error(body.error ?? `HTTP ${response.status}`);
      router.push(`/jobs/${body.job.id}`);
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(false);
    }
  }

  return (
    <form className="stack new-migration-form" onSubmit={submit}>
      <h2>新しい移行</h2>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      <label>
        移行名
        <input
          name="name"
          type="text"
          placeholder="例：営業部の文書整理"
          maxLength={100}
          required
          disabled={busy}
        />
      </label>
      <div className="source-folder" role="group" aria-labelledby="source-folder-label">
        <span id="source-folder-label" className="small">
          移行元
        </span>
        <div className="source-folder-choice">
          <div aria-live="polite">
            <strong>{folder?.name ?? 'フォルダー未選択'}</strong>
            {folder ? <p className="small muted source-folder-path">{folder.path}</p> : null}
          </div>
          <button
            type="button"
            className="secondary"
            disabled={busy || picking || !folderPickerAvailable}
            onClick={() => void selectFolder()}
          >
            {picking ? '選択中…' : folder ? '変更' : 'フォルダーを選択'}
          </button>
        </div>
        {!folderPickerAvailable || picking ? (
          <p className="small muted" role="status">
            {!folderPickerAvailable
              ? 'フォルダー選択はMacで利用できます。Mac上でアプリを起動してください。'
              : 'フォルダーを選択中…'}
          </p>
        ) : null}
      </div>
      <BoxFolderPicker
        value={destination}
        onChange={setDestination}
        onBusyChange={setSelectingDestination}
        disabled={busy || picking}
        boxMode={boxMode}
      />
      <label>
        <span>
          <input
            type="checkbox"
            checked={testMode}
            disabled={busy}
            onChange={(event) => setTestMode(event.target.checked)}
          />{' '}
          テストモード
        </span>
        {testMode ? (
          <span className="small muted">
            結果確認後、「テストを終了」で今回転送したファイルをまとめて削除します。
            Boxの企業設定により完全削除になる場合があります。
          </span>
        ) : null}
      </label>
      <details className="migration-options">
        <summary>詳細オプション</summary>
        <div className="migration-options-body">
          <label>
            <span>
              <input
                name="aiRoutingEnabled"
                type="checkbox"
                defaultChecked={aiEnabled}
                disabled={busy || !aiEnabled}
              />{' '}
              AIに配置先を提案してもらう
            </span>
          </label>
          {!aiEnabled ? (
            <p className="small muted">共通設定でAI分類が無効になっています。</p>
          ) : null}
          <label>
            同じ名前のファイルがあるとき
            <select name="conflictPolicy" defaultValue="RENAME" disabled={busy}>
              <option value="RENAME">改名して両方残す</option>
              <option value="SKIP">スキップする</option>
            </select>
          </label>
          <label>
            操作者名（任意・記録用）
            <input name="operatorLabel" type="text" placeholder="ローカル操作者" disabled={busy} />
          </label>
        </div>
      </details>
      <div className="actions">
        <button
          type="button"
          className="secondary"
          disabled={busy || picking}
          onClick={(event) =>
            event.currentTarget.closest('details.newjob')?.removeAttribute('open')
          }
        >
          キャンセル
        </button>
        <button
          type="submit"
          disabled={busy || picking || selectingDestination || !folder || !destination}
        >
          {busy ? '開始しています…' : '移行を開始'}
        </button>
      </div>
    </form>
  );
}
