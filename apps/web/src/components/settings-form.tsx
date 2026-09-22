'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import {
  MAX_FILE_CONCURRENCY,
  MAX_CHUNK_CONCURRENCY,
  type RuntimeSettings,
} from '@shuttle-lite/config/settings-schema';

export function SettingsForm({
  initial,
  revision: initialRevision,
  folderPickerAvailable,
  snowflakeKeyConfigured,
}: {
  initial: RuntimeSettings;
  revision: number;
  folderPickerAvailable: boolean;
  snowflakeKeyConfigured: boolean;
}) {
  const router = useRouter();
  const [settings, setSettings] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [revision, setRevision] = useState(initialRevision);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const changed = JSON.stringify(settings) !== JSON.stringify(saved);
  function update<K extends keyof RuntimeSettings>(key: K, value: RuntimeSettings[K]) {
    setSettings((current) => ({ ...current, [key]: value }));
    setStatus('');
    setError('');
  }
  async function chooseLogFolder() {
    setPicking(true);
    setError('');
    setStatus('');
    try {
      const response = await fetch('/api/source-folder?purpose=logs', {
        method: 'POST',
        headers: { 'x-shuttle-folder-picker': '1' },
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'フォルダーを選択できませんでした。');
      if (!result.cancelled) update('logFolder', result.path);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'フォルダーを選択できませんでした。');
    } finally {
      setPicking(false);
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-shuttle-settings': '1' },
        body: JSON.stringify({ settings, revision }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? '設定を保存できませんでした。');
      setSettings(result.settings);
      setSaved(result.settings);
      setRevision(result.revision);
      setStatus('保存しました');
      router.refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : '設定を保存できませんでした。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="settings-form">
      <fieldset disabled={busy || picking}>
        <label className="settings-row">
          <span>AI分類</span>
          <input
            type="checkbox"
            checked={settings.aiEnabled}
            onChange={(event) => update('aiEnabled', event.target.checked)}
          />
        </label>
        <label className="settings-row">
          <span>ファイルの並列数</span>
          <select
            value={settings.fileConcurrency}
            onChange={(event) => update('fileConcurrency', Number(event.target.value))}
          >
            {Array.from({ length: MAX_FILE_CONCURRENCY }, (_, i) => (
              <option key={i} value={i + 1}>
                {i + 1}
              </option>
            ))}
          </select>
        </label>
        <label className="settings-row">
          <span>分割転送の並列数</span>
          <select
            value={settings.chunkConcurrency}
            onChange={(event) => update('chunkConcurrency', Number(event.target.value))}
          >
            {Array.from({ length: MAX_CHUNK_CONCURRENCY }, (_, i) => (
              <option key={i} value={i + 1}>
                {i + 1}
              </option>
            ))}
          </select>
        </label>
        <label className="settings-row">
          <span>処理ログ</span>
          <select
            value={settings.logSink}
            onChange={(event) =>
              update('logSink', event.target.value as RuntimeSettings['logSink'])
            }
          >
            <option value="jsonl">ローカルフォルダー</option>
            <option value="snowflake">Snowflake</option>
          </select>
        </label>
        {settings.logSink === 'jsonl' ? (
          <div className="settings-row">
            <span>保存先</span>
            <div className="settings-folder">
              <span className="mono">{settings.logFolder}</span>
              <button
                type="button"
                className="secondary"
                disabled={!folderPickerAvailable}
                onClick={chooseLogFolder}
              >
                フォルダーを選択
              </button>
              {!folderPickerAvailable && <span className="hint">フォルダー選択はMacのみ対応</span>}
            </div>
          </div>
        ) : (
          <div className="settings-snowflake">
            {(
              [
                ['account', 'アカウント'],
                ['username', 'ユーザー'],
                ['warehouse', 'ウェアハウス'],
                ['database', 'データベース'],
                ['schema', 'スキーマ'],
                ['table', 'テーブル'],
                ['role', 'ロール（任意）'],
              ] as const
            ).map(([key, label]) => (
              <label className="settings-row" key={key}>
                <span>{label}</span>
                <input
                  type="text"
                  value={settings.snowflake[key]}
                  required={key !== 'role'}
                  maxLength={255}
                  onChange={(event) =>
                    update('snowflake', { ...settings.snowflake, [key]: event.target.value })
                  }
                />
              </label>
            ))}
            <div className="settings-row">
              <span>秘密鍵</span>
              <span>{snowflakeKeyConfigured ? '設定済み' : '未設定'}</span>
            </div>
            {!snowflakeKeyConfigured && (
              <p role="alert">
                Macの.envにSNOWFLAKE_PRIVATE_KEY_PATHを設定して再起動してください。
              </p>
            )}
          </div>
        )}
        <div className="settings-actions">
          <button type="submit" disabled={!changed}>
            {busy ? '保存中…' : '保存'}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={!changed}
            onClick={() => {
              setSettings(saved);
              setError('');
              setStatus('');
            }}
          >
            元に戻す
          </button>
        </div>
      </fieldset>
      {picking && <p role="status">フォルダーを選択中…</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {status && <p role="status">{status}</p>}
    </form>
  );
}
