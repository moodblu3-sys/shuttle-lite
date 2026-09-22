'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { CommandType } from '@shuttle-lite/core';
import type { JobSnapshot } from '@shuttle-lite/telemetry';

interface ControlButton {
  readonly type: CommandType;
  readonly label: string;
  readonly variant?: 'primary' | 'secondary' | 'ghost';
}

/**
 * Only the operations that make sense for the current job state are offered.
 * Showing every command at once made it impossible to tell what to press.
 */
function buttonsFor(snapshot: JobSnapshot): {
  primary: ControlButton[];
  secondary: ControlButton[];
} {
  const primary: ControlButton[] = [];
  const secondary: ControlButton[] = [
    { type: 'RESCAN_JOB', label: 'source folderを再scan', variant: 'ghost' },
    { type: 'GENERATE_REPORT', label: 'ReportをBoxへupload', variant: 'ghost' },
  ];

  switch (snapshot.job.state) {
    case 'QUEUED':
      primary.push({ type: 'START_JOB', label: 'この移行を開始する', variant: 'primary' });
      break;
    case 'PAUSED':
      primary.push({ type: 'RESUME_JOB', label: '再開する', variant: 'primary' });
      break;
    case 'SCANNING':
    case 'RUNNING':
      primary.push({ type: 'PAUSE_JOB', label: '一時停止', variant: 'secondary' });
      break;
    case 'FAILED':
      primary.push({ type: 'START_JOB', label: '再開する', variant: 'primary' });
      break;
    case 'COMPLETED':
      break;
  }

  if (snapshot.failedItems > 0) {
    primary.push({
      type: 'RETRY_FAILED',
      label: `失敗した${snapshot.failedItems}件を再実行`,
      variant: 'secondary',
    });
  }
  return { primary, secondary };
}

export function JobControls({ jobId, snapshot }: { jobId: string; snapshot: JobSnapshot }) {
  const router = useRouter();
  const [pending, setPending] = useState<CommandType | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const { primary, secondary } = buttonsFor(snapshot);

  async function send(button: ControlButton) {
    setPending(button.type);
    setMessage(null);
    try {
      const response = await fetch(`/api/jobs/${jobId}/commands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: button.type }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      setMessage(`${button.label} を受け付けました。workerが実行します。`);
      router.refresh();
    } catch (cause) {
      setMessage(`送信に失敗しました: ${(cause as Error).message}`);
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <h2>操作</h2>
        <button type="button" className="ghost" onClick={() => setShowAll((value) => !value)}>
          {showAll ? 'その他を隠す' : 'その他の操作'}
        </button>
      </div>

      <div className="actions">
        {primary.length === 0 ? (
          <span className="muted small">この状態で必要な操作はありません。</span>
        ) : (
          primary.map((button) => (
            <button
              key={button.type}
              type="button"
              className={button.variant === 'primary' ? undefined : button.variant}
              disabled={pending !== null}
              onClick={() => void send(button)}
            >
              {pending === button.type ? '送信中…' : button.label}
            </button>
          ))
        )}
        <a className="linkbtn" href={`/api/jobs/${jobId}/report?format=csv`}>
          CSV
        </a>
        <a className="linkbtn" href={`/api/jobs/${jobId}/report?format=json`}>
          JSON
        </a>
      </div>

      {showAll ? (
        <div className="actions" style={{ marginTop: 10 }}>
          {secondary.map((button) => (
            <button
              key={button.type}
              type="button"
              className="ghost"
              disabled={pending !== null}
              onClick={() => void send(button)}
            >
              {pending === button.type ? '送信中…' : button.label}
            </button>
          ))}
        </div>
      ) : null}

      {message ? <p className="small muted">{message}</p> : null}
      <p className="small muted">
        操作はcommandとしてSQLiteへ記録され、workerが実行します。UIから直接stateを書き換えません。
      </p>
    </div>
  );
}
