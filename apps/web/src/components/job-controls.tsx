'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { CommandType, JobCommandRecord } from '@shuttle-lite/core';
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
    { type: 'RESCAN_JOB', label: '移行元を再スキャン', variant: 'ghost' },
    { type: 'GENERATE_REPORT', label: 'レポートをBoxに保存', variant: 'ghost' },
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
  const [submitted, setSubmitted] = useState<JobCommandRecord | null>(null);
  const [showAll, setShowAll] = useState(false);
  const { primary, secondary } = buttonsFor(snapshot);
  const latest = snapshot.commands[0];
  const accepted = submitted
    ? (snapshot.commands.find((command) => command.id === submitted.id) ??
      (latest && latest.createdAt > submitted.createdAt ? null : submitted))
    : null;
  const operation =
    accepted && (!latest || accepted.createdAt >= latest.createdAt)
      ? accepted
      : (latest ?? accepted);
  const waiting =
    snapshot.commands.some(
      (command) => command.state === 'PENDING' || command.state === 'CLAIMED',
    ) ||
    accepted?.state === 'PENDING' ||
    accepted?.state === 'CLAIMED';
  const disabled = pending !== null || waiting;

  async function send(button: ControlButton) {
    setPending(button.type);
    setMessage(null);
    try {
      const response = await fetch(`/api/jobs/${jobId}/commands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: button.type }),
      });
      const body = (await response.json()) as { error?: string; command: JobCommandRecord };
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      setSubmitted(body.command);
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
              disabled={disabled}
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
              disabled={disabled}
              onClick={() => void send(button)}
            >
              {pending === button.type ? '送信中…' : button.label}
            </button>
          ))}
        </div>
      ) : null}

      {operation ? <OperationResult command={operation} /> : null}
      {message ? (
        <p className="error" role="alert">
          {message}
        </p>
      ) : null}
    </div>
  );
}

const OPERATION_LABELS: Partial<Record<CommandType, string>> = {
  START_JOB: '移行開始',
  RESUME_JOB: '再開',
  PAUSE_JOB: '一時停止',
  RESCAN_JOB: '再スキャン',
  RETRY_FAILED: '失敗したファイルの再実行',
  GENERATE_REPORT: 'レポートのBox保存',
};

export function OperationResult({ command }: { command: JobCommandRecord }) {
  const label = OPERATION_LABELS[command.type] ?? '操作';
  const message =
    command.state === 'REJECTED'
      ? `${label}に失敗しました。${command.rejectionReason ?? ''}`
      : command.state === 'PENDING'
        ? `${label}を受け付けました。`
        : command.state === 'CLAIMED'
          ? `${label}を実行中です。`
          : command.type === 'GENERATE_REPORT'
            ? 'レポートをBoxに保存しました。'
            : command.type === 'PAUSE_JOB'
              ? '一時停止を要求しました。'
              : `${label}の指示を実行しました。`;
  return (
    <p
      className={command.state === 'REJECTED' ? 'error' : 'small muted'}
      role={command.state === 'REJECTED' ? 'alert' : 'status'}
    >
      {message}
    </p>
  );
}
