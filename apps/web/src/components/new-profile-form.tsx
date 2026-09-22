'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function NewProfileForm({
  defaultSourceRoot,
  defaultFileConcurrency,
  defaultChunkConcurrency,
}: {
  defaultSourceRoot: string;
  defaultFileConcurrency: number;
  defaultChunkConcurrency: number;
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
      const response = await fetch('/api/profiles', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: form.get('name'),
          sourceRootPath: form.get('sourceRootPath'),
          fileConcurrency: Number(form.get('fileConcurrency')),
          chunkConcurrency: Number(form.get('chunkConcurrency')),
          aiRoutingEnabled: form.get('aiRoutingEnabled') === 'on',
          snowflakeLoggingEnabled: form.get('snowflakeLoggingEnabled') === 'on',
          conflictPolicy: form.get('conflictPolicy'),
        }),
      });
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }
      router.refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      {error ? <p className="error">{error}</p> : null}
      <div className="row">
        <label>
          Profile name
          <input name="name" type="text" defaultValue="fixtures-demo" required />
        </label>
        <label style={{ flex: '2 1 320px' }}>
          Source root path (macOSのlocal folder)
          <input name="sourceRootPath" type="text" defaultValue={defaultSourceRoot} required />
        </label>
      </div>
      <div className="row">
        <label>
          File concurrency
          <input
            name="fileConcurrency"
            type="number"
            min={1}
            max={8}
            defaultValue={defaultFileConcurrency}
          />
        </label>
        <label>
          Chunk concurrency
          <input
            name="chunkConcurrency"
            type="number"
            min={1}
            max={8}
            defaultValue={defaultChunkConcurrency}
          />
        </label>
        {/* Box Shuttleと同じ2択。上書きはどちらでも起きない。 */}
        <label>
          配置先に同名fileがあるとき
          <select name="conflictPolicy" defaultValue="RENAME">
            <option value="RENAME">改名して両方残す</option>
            <option value="SKIP">skipして後で対応する</option>
          </select>
        </label>
        <label className="small">
          <span>
            <input name="aiRoutingEnabled" type="checkbox" defaultChecked /> AI routingを使う
          </span>
        </label>
        <label className="small">
          <span>
            <input name="snowflakeLoggingEnabled" type="checkbox" defaultChecked /> Snowflake
            loggingを使う
          </span>
        </label>
      </div>
      <p className="small muted">
        Credentialとproxy passwordはprofileへ保存しません。環境変数から読み込みます。
      </p>
      <div className="actions">
        <button type="submit" disabled={busy}>
          {busy ? '作成中…' : 'Profileを作成'}
        </button>
      </div>
    </form>
  );
}
