'use client';

import { useEffect, useState } from 'react';
// Deep import: the package barrel reaches node:fs, which cannot be bundled
// for the browser.
import { formatBytes, formatDuration, PHASE_LABELS } from '@shuttle-lite/core/progress';
import type { JobSnapshot } from '@shuttle-lite/telemetry';
import { JobControls } from './job-controls';
import { StatePill } from './state-pill';

export function ProgressView({ jobId, initial }: { jobId: string; initial: JobSnapshot }) {
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
      <NextActionBanner jobId={jobId} snapshot={snapshot} />

      <div className="card">
        <div className="card-head">
          <h2>
            進捗 <StatePill state={snapshot.job.state} />
          </h2>
          <span className={`conn conn-${live}`}>
            {live === 'live'
              ? '自動更新中'
              : live === 'connecting'
                ? '接続中…'
                : '更新が止まっています'}
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
            note={
              snapshot.reviewBacklog > 0
                ? `うち ${snapshot.reviewBacklog} 件が承認待ちで止まっています`
                : null
            }
          />
          <ProgressTrack
            label="最終folderへ配置"
            done={snapshot.completedItems}
            total={snapshot.totalItems}
            percent={percent(snapshot.completedItems)}
            tone="done"
            note={
              snapshot.completedItems === 0 && snapshot.reviewBacklog > 0
                ? '承認するとここが進みます'
                : null
            }
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
            sub={snapshot.reviewBacklog > 0 ? '人の判断が必要' : '待ちなし'}
            tone={snapshot.reviewBacklog > 0 ? 'wait' : undefined}
          />
          <Metric
            label="失敗"
            value={String(snapshot.failedItems)}
            sub={snapshot.skippedItems > 0 ? `skip ${snapshot.skippedItems} 件` : '—'}
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
                : snapshot.transferredBytes >= snapshot.totalBytes
                  ? '全件転送済み'
                  : `全 ${formatBytes(snapshot.totalBytes)}`
            }
          />
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Phase</h2>
          <span className="small muted">
            Snowflake配信 待ち {snapshot.outbox.pending} / 済 {snapshot.outbox.delivered}
            {snapshot.outbox.failed > 0 ? ` / 失敗 ${snapshot.outbox.failed}` : ''}
          </span>
        </div>
        <Stepper snapshot={snapshot} />
        <details className="footnote">
          <summary className="small muted">phaseの読み方</summary>
          <p className="small muted">
            uploadとAI処理は別queueで動くため、AI待ちが別fileのtransferを止めることはありません。
            Snowflakeへの配信待ちはtransferの失敗ではなく、別のdelivery statusです。
          </p>
        </details>
      </div>

      <JobControls jobId={jobId} snapshot={snapshot} />

      <details className="card" onToggle={(event) => setShowDetail(event.currentTarget.open)}>
        <summary>
          <h2>詳しい状況</h2>
        </summary>
        {/* Mounted only while open so the tables stay out of the initial paint. */}
        <div className="details-body">
          {showDetail ? <DetailPanels snapshot={snapshot} /> : null}
        </div>
      </details>
    </>
  );
}

function ProgressTrack({
  label,
  done,
  total,
  percent,
  tone,
  note,
}: {
  label: string;
  done: number;
  total: number;
  percent: number;
  tone: 'done' | 'staged';
  note: string | null;
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
      {note ? <p className="small muted track-note">{note}</p> : null}
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
  sub: string;
  tone?: 'wait' | 'bad';
}) {
  return (
    <div className={`metric${tone ? ` metric-${tone}` : ''}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      <div className="small muted">{sub}</div>
    </div>
  );
}

function NextActionBanner({ jobId, snapshot }: { jobId: string; snapshot: JobSnapshot }) {
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
        <div className="next-action-label">次にやること</div>
        <div className="next-action-message">{nextAction.message}</div>
      </div>
      {nextAction.kind === 'REVIEW' ? (
        <a className="next-action-cta" href={`/jobs/${jobId}/review`}>
          承認画面をひらく（{nextAction.count}件）
        </a>
      ) : null}
      {nextAction.kind === 'REPORT' ? (
        <a className="next-action-cta" href={`/api/jobs/${jobId}/report?format=csv`}>
          CSV reportをdownload
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
        <h3>処理中のfile</h3>
        {snapshot.activeItems.length === 0 ? (
          <p className="muted small">処理中のfileはありません。</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>File</th>
                <th>State</th>
                <th>転送</th>
                <th>Retry</th>
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

        <h3>Error category</h3>
        {snapshot.errorCategories.length === 0 ? (
          <p className="muted small">errorはありません。</p>
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
        <h3>最近のevent</h3>
        <div className="events">
          <table>
            <thead>
              <tr>
                <th>時刻</th>
                <th>Phase</th>
                <th>Status</th>
                <th>内容</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.recentEvents.map((event) => (
                <tr key={event.id}>
                  <td className="small mono">{event.createdAt.slice(11, 19)}</td>
                  <td className="small">{event.phase}</td>
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
