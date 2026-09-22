'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function NewJobForm({
  aiEnabled,
  boxMode,
}: {
  aiEnabled: boolean;
  boxMode: 'real' | 'fake';
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: form.get('name'),
          sourceRootPath: form.get('sourceRootPath'),
          operatorLabel: form.get('operatorLabel'),
          aiRoutingEnabled: aiEnabled && form.get('aiRoutingEnabled') === 'on',
          conflictPolicy: form.get('conflictPolicy'),
          autoStart: true,
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
      <label>
        移行元フォルダー
        <input
          name="sourceRootPath"
          type="text"
          placeholder="/Users/…/Documents/移行する文書"
          required
          disabled={busy}
          aria-describedby="source-path-help"
        />
      </label>
      <p id="source-path-help" className="small muted">
        Finderでフォルダーを選び、⌥⌘Cでパスをコピーして貼り付けます。
      </p>
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
      <p className="small muted">
        {boxMode === 'real'
          ? '開始するとBoxの一時保管先へアップロードします。'
          : '現在はテスト環境です。実Boxへのアップロードは行いません。'}
        最終配置は確認・承認後に行います。元ファイルは残ります。
      </p>
      <div className="actions">
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={(event) =>
            event.currentTarget.closest('details.newjob')?.removeAttribute('open')
          }
        >
          キャンセル
        </button>
        <button type="submit" disabled={busy}>
          {busy ? '開始しています…' : '移行を開始'}
        </button>
      </div>
    </form>
  );
}
