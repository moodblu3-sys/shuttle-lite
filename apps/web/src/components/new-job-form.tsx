'use client';

import { BoxLabel } from './box-label';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { BoxFolderPicker, type SelectedBoxFolder } from './box-folder-picker';
import type { FolderSelection } from '../lib/folder-picker';
import type { SourceCheck } from '../lib/source-check';
import { formatBytes } from '@shuttle-lite/core/progress';
import { WorkspaceIcon } from './workspace-icon';
import type { BusinessTemplate } from '@shuttle-lite/core';
import { JobMetadataPicker } from './job-metadata-picker';
import {
  BoxDestinationPane,
  SourceFolderPane,
  type SourceFolder,
} from './migration-folder-browser';

export function NewJobForm({
  aiEnabled,
  boxMode,
  folderPickerAvailable,
  authenticated = false,
  classicFolderPicker = false,
}: {
  authenticated?: boolean;
  classicFolderPicker?: boolean;
  aiEnabled: boolean;
  boxMode: 'real' | 'fake';
  folderPickerAvailable: boolean;
}) {
  const router = useRouter();
  const [migrationMode, setMigrationMode] = useState<'AS_IS' | 'AI_ORGANIZE'>(
    aiEnabled ? 'AI_ORGANIZE' : 'AS_IS',
  );
  const [busy, setBusy] = useState(false);
  const [optionsOpened, setOptionsOpened] = useState(false);
  const [testMode, setTestMode] = useState(false);
  const [metadataTemplates, setMetadataTemplates] = useState<BusinessTemplate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [folder, setFolder] = useState<Extract<FolderSelection, { cancelled: false }> | null>(null);
  const [destination, setDestination] = useState<SelectedBoxFolder | null>(null);
  const [sourceAnchor, setSourceAnchor] = useState<SourceFolder | null>(null);
  const [browsingSource, setBrowsingSource] = useState(false);
  const dualPane = migrationMode === 'AS_IS' && !classicFolderPicker;
  const [selectingDestination, setSelectingDestination] = useState(false);
  const [picking, setPicking] = useState(false);
  const pickerRequest = useRef<AbortController | null>(null);
  const checkRequest = useRef<AbortController | null>(null);
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState<SourceCheck | null>(null);
  const sourceReady =
    checked?.complete &&
    checked.errorCount === 0 &&
    !!checked.signature &&
    (migrationMode === 'AS_IS' || checked.fileCount > 0);

  useEffect(
    () => () => {
      pickerRequest.current?.abort();
      checkRequest.current?.abort();
    },
    [],
  );

  async function inspectSource() {
    if (!folder || checking || checkRequest.current || busy) return;
    const controller = new AbortController();
    checkRequest.current = controller;
    setChecking(true);
    setChecked(null);
    setError(null);
    try {
      const response = await fetch('/api/source-check', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-shuttle-source-check': '1' },
        body: JSON.stringify({ sourceRootPath: folder.path }),
        signal: controller.signal,
      });
      const result = (await response.json()) as SourceCheck & { error?: string };
      if (!response.ok) throw new Error(result.error ?? '確認できませんでした。');
      if (!controller.signal.aborted) setChecked(result);
    } catch (cause) {
      if (!controller.signal.aborted) setError((cause as Error).message);
    } finally {
      checkRequest.current = null;
      if (!controller.signal.aborted) setChecking(false);
    }
  }

  async function selectFolder() {
    if (pickerRequest.current || busy || checking) return;
    const controller = new AbortController();
    pickerRequest.current = controller;
    setPicking(true);
    setError(null);
    try {
      const response = await fetch(
        dualPane ? '/api/source-folder?browse=1' : '/api/source-folder',
        {
          method: 'POST',
          headers: { 'x-shuttle-folder-picker': '1' },
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error ?? 'フォルダーを選択できませんでした。');
      }
      const selection = (await response.json()) as FolderSelection;
      if (!selection.cancelled) {
        setFolder(selection);
        setSourceAnchor(selection);
        setChecked(null);
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError((cause as Error).message);
    } finally {
      pickerRequest.current = null;
      if (!controller.signal.aborted) setPicking(false);
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || picking || checking || selectingDestination || browsingSource) return;
    if (!folder) {
      setError('移行元フォルダーを選択してください。');
      return;
    }
    if (!destination) {
      setError('Boxの移行先フォルダーを選択してください。');
      return;
    }
    if (!sourceReady) {
      setError('移行元を確認してください。');
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
          migrationMode,
          name: form.get('name'),
          sourceRootPath: folder.path,
          sourceCheck: checked!.signature,
          destinationFolderId: destination.folderId,
          operatorLabel: form.get('operatorLabel'),
          aiRoutingEnabled: migrationMode !== 'AS_IS' && aiEnabled,
          conflictPolicy: form.get('conflictPolicy'),
          metadataTemplates:
            migrationMode === 'AS_IS'
              ? []
              : metadataTemplates.map(({ scope, templateKey }) => ({ scope, templateKey })),
          autoStart: true,
          testMode,
        }),
      });
      const body = (await response.json()) as {
        job?: { id: string };
        error?: string;
        sourceChanged?: boolean;
      };
      if (body.sourceChanged) setChecked(null);
      if (!response.ok || !body.job) throw new Error(body.error ?? `HTTP ${response.status}`);
      router.push(`/jobs/${body.job.id}`);
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(false);
    }
  }

  return (
    <form className="stack new-migration-form" onSubmit={submit}>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      <fieldset
        className="migration-mode-options"
        disabled={busy || picking || checking || selectingDestination || browsingSource}
      >
        <legend>移行方式</legend>
        <div className="migration-mode-cards">
          {(
            [
              ['AI_ORGANIZE', 'AIで整理して移行', '内容から配置先・メタデータを提案', 'review'],
              ['AS_IS', 'そのまま移行', 'フォルダー構成を維持して転送', 'folder'],
            ] as const
          ).map(([value, title, description, icon]) => (
            <label
              key={value}
              className={`migration-mode-card ${migrationMode === value ? 'selected' : ''}`}
            >
              <input
                type="radio"
                name="migrationMode"
                value={value}
                disabled={value === 'AI_ORGANIZE' && !aiEnabled}
                checked={migrationMode === value}
                onChange={() => {
                  setMigrationMode(value);
                  if (value === 'AS_IS' && !classicFolderPicker && !sourceAnchor?.browseToken) {
                    setFolder(null);
                    setChecked(null);
                    setSourceAnchor(null);
                  }
                  setDestination(null);
                }}
              />
              <span>
                <WorkspaceIcon kind={icon} />
                <strong>{title}</strong>
                <span>{description}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
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
      {dualPane ? (
        <>
          <div className="migration-dual-pane">
            <SourceFolderPane
              key={sourceAnchor?.browseToken ?? 'empty'}
              anchor={sourceAnchor}
              value={folder}
              onChange={(selected) => {
                setFolder(selected);
                setChecked(null);
              }}
              onChooseRoot={() => void selectFolder()}
              onBusyChange={setBrowsingSource}
              disabled={busy || checking}
              picking={picking}
              available={folderPickerAvailable}
            />
            <BoxDestinationPane
              value={destination}
              onChange={setDestination}
              onBusyChange={setSelectingDestination}
              disabled={busy || picking || checking}
            />
          </div>
          <div className="migration-path-summary" aria-label="選択した移行経路" aria-live="polite">
            <div>
              <span>移行元</span>
              <strong>{folder?.path ?? '未選択'}</strong>
            </div>
            <span className="migration-path-arrow" aria-hidden="true">
              →
            </span>
            <div>
              <BoxLabel>Boxの最終配置先</BoxLabel>
              <strong>
                {destination && folder
                  ? `${destination.path ?? destination.name} / ${folder.name}`
                  : '未選択'}
              </strong>
            </div>
          </div>
        </>
      ) : (
        <div className="migration-folder-columns">
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
                disabled={busy || picking || checking || !folderPickerAvailable}
                onClick={() => void selectFolder()}
              >
                {picking ? '選択中…' : folder ? '変更' : 'フォルダーを選択'}
              </button>
            </div>
            {!folderPickerAvailable || picking ? (
              <p className="small muted" role="status">
                {!folderPickerAvailable ? 'フォルダー選択はMacのみ対応' : 'フォルダーを選択中…'}
              </p>
            ) : null}
          </div>
          <BoxFolderPicker
            key={migrationMode}
            migrationMode={migrationMode}
            sourceRootName={folder?.name}
            value={destination}
            onChange={setDestination}
            onBusyChange={setSelectingDestination}
            disabled={busy || picking || checking}
            boxMode={boxMode}
          />
        </div>
      )}
      <section className="source-check" aria-label="開始前の確認">
        <div className="card-head">
          <h2>開始前の確認</h2>
          <button
            type="button"
            className="secondary"
            disabled={!folder || busy || picking || checking || browsingSource}
            onClick={() => void inspectSource()}
          >
            {checking ? '確認中…' : checked ? '再確認' : '移行元を確認'}
          </button>
        </div>
        {checked ? (
          <div aria-live="polite">
            <div className="source-check-metrics">
              <span>
                ファイル <strong>{checked.fileCount}件</strong>
              </span>
              <span>
                合計容量 <strong>{formatBytes(checked.totalBytes)}</strong>
              </span>
              <span>
                フォルダー <strong>{checked.folderCount}件</strong>
              </span>
              <span>
                読み取りエラー <strong>{checked.errorCount}件</strong>
              </span>
            </div>
            {checked.excludedCount > 0 ? (
              <p className="small muted">
                隠し項目・一時ファイルなど対象外 {checked.excludedCount}件
              </p>
            ) : null}
            {!checked.complete || checked.errorCount > 0 ? (
              <p className="error">確認未完了（件数・容量は読み取れた分のみ）</p>
            ) : null}
            {checked.errorCount > 0 ? (
              <div role="alert">
                <ul>
                  {checked.errors.map((e, i) => (
                    <li key={i}>
                      {e.path}：{e.message}
                    </li>
                  ))}
                </ul>
                {checked.errorCount > checked.errors.length ? (
                  <p>先頭{checked.errors.length}件を表示</p>
                ) : null}
              </div>
            ) : checked.fileCount === 0 && migrationMode !== 'AS_IS' ? (
              <p>対象ファイルがありません。</p>
            ) : checked.complete ? (
              <p className="source-check-ok">確認済み</p>
            ) : null}
          </div>
        ) : (
          <p className="small muted">
            {checking ? 'ファイル数・容量・読み取り可否を確認しています。' : '未確認'}
          </p>
        )}
      </section>
      {!authenticated && (
        <label>
          操作者名（任意）
          <input name="operatorLabel" type="text" placeholder="ローカル操作者" disabled={busy} />
        </label>
      )}
      <details
        className="migration-options"
        onToggle={(event) => {
          if (event.currentTarget.open) setOptionsOpened(true);
        }}
      >
        <summary>詳細オプション</summary>
        <div className="migration-options-body">
          <label>
            同名ファイルの扱い
            <select
              key={`${migrationMode}-${testMode}`}
              name="conflictPolicy"
              defaultValue="RENAME"
              disabled={busy}
            >
              <option value="RENAME">改名して両方残す</option>
              {migrationMode === 'AS_IS' && !testMode ? (
                <option value="OVERWRITE">上書き（新しいバージョン）</option>
              ) : null}
              <option value="SKIP">スキップ</option>
            </select>
          </label>
          {migrationMode !== 'AS_IS' ? (
            <JobMetadataPicker
              active={optionsOpened}
              selected={metadataTemplates}
              onChange={setMetadataTemplates}
              disabled={busy}
            />
          ) : null}
        </div>
      </details>
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
      </label>
      <div className="actions">
        <button
          type="button"
          className="secondary"
          disabled={busy || picking || checking}
          onClick={() => router.push('/')}
        >
          キャンセル
        </button>
        <button
          type="submit"
          disabled={
            busy ||
            picking ||
            checking ||
            selectingDestination ||
            browsingSource ||
            !folder ||
            !destination ||
            !sourceReady
          }
        >
          {busy ? '開始中…' : '移行を開始'}
        </button>
      </div>
    </form>
  );
}
