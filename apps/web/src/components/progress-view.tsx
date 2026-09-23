'use client';

import { useEffect, useState, type ReactNode } from 'react';
// Deep import: the package barrel reaches node:fs, which cannot be bundled
// for the browser.
import { formatBytes, formatDuration, PHASE_LABELS } from '@shuttle-lite/core/progress';
import type { JobSnapshot } from '@shuttle-lite/telemetry';
import { JobControls } from './job-controls';
import { StatePill } from './state-pill';
import { JobIdentity } from './job-card';
import type { MigrationProfile } from '@shuttle-lite/core';

export function ProgressView({
  jobId,
  initial,
  profile,
  children,
}: {
  jobId: string;
  initial: JobSnapshot;
  profile: MigrationProfile | null;
  children?: ReactNode;
}) {
  const [snapshot, setSnapshot] = useState<JobSnapshot>(initial);
  const [live, setLive] = useState<'connecting' | 'live' | 'lost'>('connecting');
  const [showDetail, setShowDetail] = useState(false);

  useEffect(() => {
    const source = new EventSource(`/api/jobs/${jobId}/events`);
    source.onopen = () => setLive('live');
    source.onerror = () => setLive('lost');
    source.onmessage = (event) => {
      try {
        setSnapshot(JSON.parse(event.data as string) as JobSnapshot);
        setLive('live');
      } catch {
        // Ignore a partial frame and wait for the next one.
      }
    };
    return () => source.close();
  }, [jobId]);

  const percent = (value: number) =>
    snapshot.totalItems > 0 ? Math.round((value / snapshot.totalItems) * 100) : 0;

  return (
    <>
      <ProgressIdentity snapshot={snapshot} profile={profile} />
      {children}
      {snapshot.workerUnavailable ? (
        <p className="error" role="alert">
          転送処理の応答がありません
        </p>
      ) : (
        <NextActionBanner jobId={jobId} snapshot={snapshot} />
      )}

      <div className="card">
        <div className="card-head">
          <h2>
            {snapshot.job.cleanupState === 'NONE' ? (
              <>
                進捗 <StatePill state={snapshot.job.state} />
              </>
            ) : (
              'テストの実行履歴'
            )}
          </h2>
          <span className={`conn conn-${live}`}>
            {live === 'live'
              ? '自動更新中'
              : live === 'connecting'
                ? '接続中…'
                : '自動更新が切断されました'}
          </span>
        </div>

        {/* Two independent axes. Overlaying them on one bar made a fully
            staged job look 0% complete. */}
        <div className="progress-stack">
          <ProgressTrack
            label="Boxへ転送"
            done={snapshot.transferredItems}
            total={snapshot.totalItems}
            percent={percent(snapshot.transferredItems)}
            tone="staged"
          />
          <ProgressTrack
            label="最終フォルダーへ配置"
            done={snapshot.completedItems}
            total={snapshot.totalItems}
            percent={percent(snapshot.completedItems)}
            tone="done"
          />
        </div>

        <div className="grid cols-4" style={{ marginTop: 16 }}>
          <Metric
            label="完了"
            value={String(snapshot.completedItems)}
            sub={`全 ${snapshot.totalItems} 件`}
          />
          <Metric
            label="承認待ち"
            value={String(snapshot.reviewBacklog)}
            tone={snapshot.reviewBacklog > 0 ? 'wait' : undefined}
          />
          <Metric
            label="失敗"
            value={String(snapshot.failedItems)}
            sub={snapshot.skippedItems > 0 ? `スキップ ${snapshot.skippedItems} 件` : undefined}
            tone={snapshot.failedItems > 0 ? 'bad' : undefined}
          />
          <Metric
            label={snapshot.working ? '転送速度' : '転送量'}
            value={
              snapshot.working
                ? `${formatBytes(snapshot.throughputBytesPerSecond)}/s`
                : formatBytes(snapshot.transferredBytes)
            }
            sub={
              snapshot.working
                ? `残り ${formatDuration(snapshot.etaSeconds)}`
                : snapshot.totalItems > 0 && snapshot.transferredItems === snapshot.totalItems
                  ? '全件転送済み'
                  : snapshot.totalItems === 0
                    ? '対象なし'
                    : `全 ${formatBytes(snapshot.totalBytes)}`
            }
          />
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>処理の内訳</h2>
          <span className="small muted">
            ログ記録 待ち {snapshot.outbox.pending} / 済 {snapshot.outbox.delivered}
            {snapshot.outbox.failed > 0 ? ` / 失敗 ${snapshot.outbox.failed}` : ''}
          </span>
        </div>
        <Stepper snapshot={snapshot} />
      </div>

      <JobControls jobId={jobId} snapshot={snapshot} />

      <details className="card" onToggle={(event) => setShowDetail(event.currentTarget.open)}>
        <summary>
          <h2>詳細</h2>
        </summary>
        {/* Mounted only while open so the tables stay out of the initial paint. */}
        <div className="details-body">
          {showDetail ? <DetailPanels snapshot={snapshot} /> : null}
        </div>
      </details>
    </>
  );
}

export function ProgressIdentity({
  snapshot,
  profile,
}: {
  snapshot: JobSnapshot;
  profile: MigrationProfile | null;
}) {
  return (
    <>
      <div className="jobcard job-head">
        <div className="jobcard-main">
          <JobIdentity job={snapshot.job} snapshot={snapshot} profile={profile} />
          <details className="job-ids">
            <summary className="small muted">ID</summary>
            <dl className="kv small">
              <dt>移行ID</dt>
              <dd className="mono">{snapshot.job.id}</dd>
              <dt>一時保管先ID</dt>
              <dd className="mono">{snapshot.job.stagingFolderId ?? '未作成'}</dd>
            </dl>
          </details>
        </div>
        <p className="small muted jobcard-note">
          操作者 {snapshot.job.operatorLabel} ・ 移行元{' '}
          <span className="mono">{profile?.sourceRootPath ?? '-'}</span>
        </p>
      </div>
      {snapshot.job.lastError && (
        <p className="error" role="alert">
          {snapshot.job.lastErrorCategory}: {snapshot.job.lastError}
        </p>
      )}
    </>
  );
}

function ProgressTrack({
  label,
  done,
  total,
  percent,
  tone,
}: {
  label: string;
  done: number;
  total: number;
  percent: number;
  tone: 'done' | 'staged';
}) {
  return (
    <div className="track">
      <div className="progress-legend">
        <span>
          {label} <strong>{done}</strong> / {total} 件
        </span>
        <span className="muted">{percent}%</span>
      </div>
      <div className="bar">
        <span className={`bar-${tone}`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'wait' | 'bad';
}) {
  return (
    <div className={`metric${tone ? ` metric-${tone}` : ''}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub ? <div className="small muted">{sub}</div> : null}
    </div>
  );
}

function NextActionBanner({ jobId, snapshot }: { jobId: string; snapshot: JobSnapshot }) {
  if (snapshot.job.cleanupState !== 'NONE')
    return (
      <div className="next-action next-action-wait" role="status">
        <div>
          <div className="next-action-label">テスト終了</div>
          <div className="next-action-message">{snapshot.job.cleanupMessage}</div>
          <p className="small">削除前の移行結果</p>
        </div>
      </div>
    );
  const { nextAction } = snapshot;
  const tone =
    nextAction.kind === 'REVIEW'
      ? 'wait'
      : nextAction.kind === 'RETRY_FAILED'
        ? 'bad'
        : nextAction.kind === 'REPORT'
          ? 'ok'
          : 'run';

  return (
    <div className={`next-action next-action-${tone}`}>
      <div>
        <div className="next-action-message">{nextAction.message}</div>
      </div>
      {nextAction.kind === 'REVIEW' ? (
        <a className="next-action-cta" href={`/jobs/${jobId}/review`}>
          承認待ちを確認（{nextAction.count}件）
        </a>
      ) : null}
      {nextAction.kind === 'REPORT' ? (
        <a className="next-action-cta" href={`/api/jobs/${jobId}/report?format=csv`}>
          CSVレポートを取得
        </a>
      ) : null}
    </div>
  );
}

function Stepper({ snapshot }: { snapshot: JobSnapshot }) {
  const phases = snapshot.phases.filter((phase) => phase.phase !== 'TELEMETRY');
  return (
    <ol className="stepper">
      {phases.map((phase) => {
        const total = phase.pending + phase.active + phase.done + phase.failed;
        const state =
          phase.failed > 0
            ? 'bad'
            : phase.active > 0
              ? 'active'
              : total > 0 && phase.done === total
                ? 'done'
                : 'idle';
        return (
          <li key={phase.phase} className={`step step-${state}`}>
            <span className="step-name">{PHASE_LABELS[phase.phase]}</span>
            <span className="step-count">
              {phase.done}/{total}
            </span>
            {phase.active > 0 ? <span className="step-badge">処理中 {phase.active}</span> : null}
            {phase.failed > 0 ? <span className="step-badge bad">失敗 {phase.failed}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

function DetailPanels({ snapshot }: { snapshot: JobSnapshot }) {
  return (
    <div className="grid cols-2" style={{ marginTop: 12 }}>
      <div>
        <h3>処理中のファイル</h3>
        {snapshot.activeItems.length === 0 ? (
          <p className="muted small">処理中のファイルなし</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>ファイル</th>
                <th>状態</th>
                <th>転送</th>
                <th>再試行</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.activeItems.map((item) => (
                <tr key={item.itemId}>
                  <td className="mono small">{item.sourceRelativePath}</td>
                  <td>
                    <StatePill state={item.state} />
                    {item.lastErrorCategory ? (
                      <div className="small muted">{item.lastErrorCategory}</div>
                    ) : null}
                  </td>
                  <td className="small">
                    {formatBytes(item.bytesTransferred)} / {formatBytes(item.sourceSize)}
                  </td>
                  <td>{item.retryCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <h3>エラー種別</h3>
        {snapshot.errorCategories.length === 0 ? (
          <p className="muted small">エラーなし</p>
        ) : (
          <ul className="small">
            {snapshot.errorCategories.map((entry) => (
              <li key={entry.category}>
                {entry.category}: {entry.count}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h3>処理履歴</h3>
        <div className="events">
          <table>
            <thead>
              <tr>
                <th>時刻</th>
                <th>工程</th>
                <th>結果</th>
                <th>内容</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.recentEvents.map((event) => (
                <tr key={event.id}>
                  <td className="small mono">{event.createdAt.slice(11, 19)}</td>
                  <td className="small">{PHASE_LABELS[event.phase]}</td>
                  <td className="small">
                    {event.status}
                    {event.errorCategory ? (
                      <div className="small muted">{event.errorCategory}</div>
                    ) : null}
                  </td>
                  <td className="small">{event.message ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
