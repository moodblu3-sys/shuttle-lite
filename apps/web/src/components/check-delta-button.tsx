'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

/** 完了画面から差分確認を開始し、結果画面で進行状況を表示する。 */
export function CheckDeltaButton({ jobId }: { jobId: string }) {
  const router = useRouter();
  const sending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function check() {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      const status = await fetch(`/api/jobs/${jobId}/delta`, { cache: 'no-store' });
      if (!status.ok) throw new Error('差分の状態を取得できませんでした。再度お試しください。');
      const data = (await status.json().catch(() => null)) as { eligible?: boolean } | null;
      if (typeof data?.eligible !== 'boolean')
        throw new Error('差分の状態を取得できませんでした。再度お試しください。');
      // 別の実行が進んでいる場合は、その状況を確認する。二重開始しない。
      if (data.eligible) {
        const response = await fetch(`/api/jobs/${jobId}/commands`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'CHECK_DELTA', payload: {} }),
        });
        const body = (await response.json().catch(() => null)) as {
          error?: string;
          command?: { id: string };
        } | null;
        if (!response.ok || !body?.command?.id)
          throw new Error(body?.error ?? '差分確認を開始できませんでした。再度お試しください。');
      }
      router.push(`/jobs/${jobId}/delta`);
    } catch (e) {
      setError(e instanceof Error ? e.message : '差分確認を開始できませんでした。');
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <button type="button" disabled={busy} onClick={() => void check()}>
        {busy ? '確認中…' : '差分を確認'}
      </button>
      {error ? (
        <p className="error small" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
