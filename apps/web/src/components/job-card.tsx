import type { JobState, MigrationJob, MigrationProfile } from '@shuttle-lite/core';
import { formatBytes } from '@shuttle-lite/core/progress';
import type { JobSnapshot } from '@shuttle-lite/telemetry';

type Tone = 'idle' | 'run' | 'wait' | 'ok' | 'warn' | 'bad';

const STATUS: Record<JobState, { label: string; tone: Tone }> = {
  QUEUED: { label: '未開始', tone: 'idle' },
  SCANNING: { label: 'スキャン中', tone: 'run' },
  RUNNING: { label: '実行中', tone: 'run' },
  PAUSED: { label: '一時停止', tone: 'wait' },
  COMPLETED: { label: '完了', tone: 'ok' },
  FAILED: { label: '失敗', tone: 'bad' },
};

// 次の一手がCTAのlabelから読み取れない状態だけ、文章で補う。
const NOTE_KINDS = new Set(['START', 'RESUME', 'RETRY_FAILED', 'IDLE']);

function stamp(value: string | null): string {
  if (!value) return '—';
  return `${value.slice(0, 10).replace(/-/g, '/')} ${value.slice(11, 16)}`;
}

export function JobCard({
  job,
  snapshot,
  profile,
}: {
  job: MigrationJob;
  snapshot: JobSnapshot | null;
  profile: MigrationProfile | null;
}) {
  const total = snapshot?.totalItems ?? job.totalItems;
  const completed = snapshot?.completedItems ?? 0;
  const transferred = snapshot?.transferredItems ?? 0;
  const next = snapshot?.nextAction;
  const share = (value: number) => (total > 0 ? Math.round((value / total) * 100) : 0);

  return (
    <article className="jobcard">
      <div className="jobcard-main">
        <JobIdentity job={job} snapshot={snapshot} profile={profile} linked />
        <Cta job={job} snapshot={snapshot} />
      </div>

      {/* 転送と配置は別の軸。承認待ちのjobが手つかずに見えないよう両方出す。 */}
      {total > 0 ? (
        <div className="bar jobcard-bar">
          <span className="bar-done" style={{ width: `${share(completed)}%` }} />
          <span
            className="bar-staged"
            style={{ width: `${share(Math.max(0, transferred - completed))}%` }}
          />
        </div>
      ) : null}

      <dl className="jobcard-stats">
        <Stat label="合計サイズ" value={job.totalBytes > 0 ? formatBytes(job.totalBytes) : '—'} />
        <Stat label="ファイル" value={total > 0 ? `${total}` : '—'} />
        <Stat
          label="配置済み"
          value={total > 0 ? `${completed}` : '—'}
          sub={total > 0 ? `転送 ${transferred}` : undefined}
        />
        <Stat label="開始時刻" value={stamp(job.startedAt)} />
      </dl>

      {next && NOTE_KINDS.has(next.kind) ? (
        <p className="jobcard-note small muted">{next.message}</p>
      ) : null}
    </article>
  );
}

/** 一覧とjob画面で同じ identity を出すための共有部分。 */
export function JobIdentity({
  job,
  snapshot,
  profile,
  linked = false,
}: {
  job: MigrationJob;
  snapshot: JobSnapshot | null;
  profile: MigrationProfile | null;
  linked?: boolean;
}) {
  const status = STATUS[job.state];
  const failed = snapshot?.failedItems ?? 0;
  const withErrors = job.state === 'COMPLETED' && failed > 0;
  const tone = withErrors ? 'warn' : status.tone;
  const name = job.name ?? profile?.name ?? '移行';
  const starting =
    job.state === 'QUEUED' &&
    snapshot?.commands.some(
      (command) =>
        command.type === 'START_JOB' &&
        (command.state === 'PENDING' || command.state === 'CLAIMED'),
    );
  const completedLabel =
    job.state === 'COMPLETED' && snapshot?.skippedItems
      ? `終了（${snapshot.skippedItems}件スキップ）`
      : job.state === 'COMPLETED' && snapshot?.totalItems === 0
        ? '終了（対象なし）'
        : status.label;

  return (
    <>
      <MigrationIcon />
      <div className="jobcard-ident">
        {linked ? (
          <a className="jobcard-name" href={`/jobs/${job.id}`}>
            {name}
          </a>
        ) : (
          <h1 className="jobcard-name">{name}</h1>
        )}
        <div className="jobcard-tags">
          <span className="typechip">
            {profile?.aiRoutingEnabled ? 'AI分類あり' : 'ファイル移行'}
          </span>
          <span className={`jobstatus jobstatus-${tone}`}>
            <StatusGlyph tone={tone} />
            {starting ? '開始待ち' : withErrors ? `終了（${failed}件エラー）` : completedLabel}
          </span>
          <span className="jobcard-dot">·</span>
          <span className="jobcard-when">{stamp(job.startedAt ?? job.createdAt)}</span>
        </div>
      </div>
    </>
  );
}

function Cta({ job, snapshot }: { job: MigrationJob; snapshot: JobSnapshot | null }) {
  const next = snapshot?.nextAction;
  if (next?.kind === 'REVIEW') {
    return (
      <a className="jobcard-cta" href={`/jobs/${job.id}/review`}>
        承認する（{next.count}件）
      </a>
    );
  }
  const label =
    job.state === 'COMPLETED'
      ? 'レポートを見る'
      : job.state === 'QUEUED' || job.state === 'PAUSED'
        ? 'ジョブをひらく'
        : '進捗を見る';
  return (
    <a className="jobcard-cta" href={`/jobs/${job.id}`}>
      {label}
    </a>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="jobcard-stat">
      <dt>{label}</dt>
      <dd>
        {value}
        {sub ? <span className="jobcard-stat-sub"> / {sub}</span> : null}
      </dd>
    </div>
  );
}

function MigrationIcon() {
  return (
    <svg className="jobcard-icon" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <path d="M7 3.5h11.5L25 10v18.5H7z" />
      <path d="M18.5 3.5V10H25" />
      <path d="M11 15h10M11 19h10M11 23h6" />
    </svg>
  );
}

function StatusGlyph({ tone }: { tone: Tone }) {
  return (
    <svg className="jobstatus-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="7" />
      {tone === 'ok' ? <path d="M4.9 8.3l2.1 2.1 4.2-4.6" /> : null}
      {tone === 'bad' || tone === 'warn' ? <path d="M8 4.3v4.4M8 10.9v1.1" /> : null}
    </svg>
  );
}
