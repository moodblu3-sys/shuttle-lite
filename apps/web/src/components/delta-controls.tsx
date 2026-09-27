'use client';
import { useEffect, useState } from 'react';
import type { JobCommandRecord, MigrationJob } from '@shuttle-lite/core';
import type { DeltaAction, DeltaPlan } from '@shuttle-lite/db';
const LABELS: Record<DeltaAction, string> = {
  ADD: '追加',
  UPDATE: '更新',
  RETRY: '未転送',
  UNCHANGED: '変更なし',
  CONFLICT: '要対応',
  REMOVED: '元で削除',
  BOX_CHANGED: 'Box側で変更',
};
interface Data {
  runs: MigrationJob[];
  eligible: boolean;
  commands: JobCommandRecord[];
  plan: (DeltaPlan & { startedJobId: string | null }) | null;
}
export function DeltaControls({ jobId }: { jobId: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  useEffect(() => {
    let active = true;
    async function refresh() {
      try {
        const res = await fetch(`/api/jobs/${jobId}/delta`, { cache: 'no-store' });
        if (!res.ok) throw new Error('差分の取得に失敗しました。');
        const value = (await res.json()) as Data;
        if (active) {
          setData(value);
          setError(null);
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [jobId]);
  const plan = data?.plan;
  useEffect(() => {
    setExcluded([]);
    setPage(0);
  }, [plan?.id]);
  const latest = data?.commands[0];
  const pending = latest && ['PENDING', 'CLAIMED'].includes(latest.state);
  const showPlan =
    plan &&
    !plan.startedJobId &&
    !pending &&
    !(latest?.type === 'CHECK_DELTA' && latest.state === 'REJECTED');
  async function send(type: 'CHECK_DELTA' | 'START_DELTA') {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${jobId}/commands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type,
          payload: type === 'START_DELTA' ? { planId: plan?.id, excludedPaths: excluded } : {},
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? '操作に失敗しました。');
      setData((old) =>
        old ? { ...old, eligible: false, commands: [body.command, ...old.commands] } : old,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card">
      <div className="card-head">
        <h2>差分移行</h2>
        <button
          className="secondary"
          disabled={!data?.eligible || busy}
          onClick={() => void send('CHECK_DELTA')}
        >
          {pending ? '処理中…' : '差分を確認'}
        </button>
      </div>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      {latest?.state === 'REJECTED' ? (
        <p role="alert" className="error">
          {latest.rejectionReason}
        </p>
      ) : null}
      {showPlan ? (
        <>
          <div className="actions">
            {Object.entries(LABELS).map(([key, label]) => (
              <span key={key}>
                {label} {plan.entries.filter((e) => e.action === key).length}件
              </span>
            ))}
          </div>
          <table>
            <thead>
              <tr>
                <th>対象</th>
                <th>ファイル</th>
                <th>状態</th>
              </tr>
            </thead>
            <tbody>
              {plan.entries.slice(page * 100, (page + 1) * 100).map((e) => {
                const selectable = ['ADD', 'UPDATE', 'RETRY'].includes(e.action);
                return (
                  <tr key={e.path}>
                    <td>
                      {selectable ? (
                        <input
                          type="checkbox"
                          aria-label={`${e.path}を移行`}
                          checked={!excluded.includes(e.path)}
                          onChange={(event) =>
                            setExcluded((old) =>
                              event.target.checked
                                ? old.filter((p) => p !== e.path)
                                : [...old, e.path],
                            )
                          }
                        />
                      ) : null}
                    </td>
                    <td>{e.path}</td>
                    <td>
                      {LABELS[e.action]}
                      {e.reason ? <div className="small muted">{e.reason}</div> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {plan.entries.length > 100 ? (
            <div className="actions">
              <button className="ghost" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                前へ
              </button>
              <span>
                {page + 1} / {Math.ceil(plan.entries.length / 100)}
              </span>
              <button
                className="ghost"
                disabled={(page + 1) * 100 >= plan.entries.length}
                onClick={() => setPage((p) => p + 1)}
              >
                次へ
              </button>
            </div>
          ) : null}
          <button
            disabled={
              !data?.eligible ||
              busy ||
              (!plan.entries.some(
                (e) => ['ADD', 'UPDATE', 'RETRY'].includes(e.action) && !excluded.includes(e.path),
              ) &&
                !plan.folders.some((f) => !f.boxFolderId))
            }
            onClick={() => void send('START_DELTA')}
          >
            差分を移行
          </button>
        </>
      ) : null}
      {data ? (
        <details open={data.runs.length > 1}>
          <summary>実行履歴</summary>
          <ul>
            {data.runs.map((r, i) => (
              <li key={r.id}>
                <a href={`/jobs/${r.id}`}>{i === 0 ? '初回移行' : `差分 ${i}回目`}</a> ·{' '}
                {r.state === 'COMPLETED'
                  ? '完了'
                  : r.state === 'FAILED'
                    ? '失敗'
                    : r.state === 'PAUSED'
                      ? '一時停止'
                      : '処理中'}{' '}
                · {r.totalItems}件 <a href={`/api/jobs/${r.id}/report?format=csv`}>CSV</a>{' '}
                <a href={`/api/jobs/${r.id}/report?format=json`}>JSON</a>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
