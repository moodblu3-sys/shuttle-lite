import { buildJobSnapshot } from '@shuttle-lite/telemetry';
import { JobCard } from '../components/job-card';
import { NewJobForm } from '../components/new-job-form';
import { getConfig, getStore } from '../lib/runtime';

export const dynamic = 'force-dynamic';

export default function HomePage() {
  const store = getStore();
  const config = getConfig();
  const jobs = store.listJobs(20).map((job) => ({
    job,
    snapshot: buildJobSnapshot(store, job.id),
    profile: store.getProfile(job.profileId),
  }));

  return (
    <div className="page-content">
      <div className="page-head">
        <div>
          <h1 className="page-title">移行一覧</h1>
          <p className="page-desc">ファイルの移行状況を確認して、分類と承認を進めます。</p>
        </div>
        {/* Admin Consoleと同じく、新規作成は右上のprimary actionに置く。 */}
        <details className="newjob">
          <summary className="newjob-trigger">新しい移行</summary>
          <div className="newjob-panel">
            <NewJobForm aiEnabled={config.ai.enabled} boxMode={config.box.mode} />
          </div>
        </details>
      </div>

      <div className="overview" aria-label="表示中の移行の概要">
        <div>
          <span>表示中の移行</span>
          <strong>
            {jobs.length}
            <small>件</small>
          </strong>
        </div>
        <div>
          <span>承認待ちのファイル</span>
          <strong>
            {jobs.reduce((sum, { snapshot }) => sum + (snapshot?.reviewBacklog ?? 0), 0)}
            <small>件</small>
          </strong>
        </div>
        <div>
          <span>配置済みのファイル</span>
          <strong>
            {jobs.reduce((sum, { snapshot }) => sum + (snapshot?.completedItems ?? 0), 0)}
            <small>件</small>
          </strong>
        </div>
      </div>
      <div className="section-heading">
        <h2>最近の移行</h2>
        <span>直近20件まで表示</span>
      </div>
      {jobs.length === 0 ? (
        <p className="empty">まだ移行ジョブはありません。右上の「新しい移行」から作成します。</p>
      ) : (
        <div className="jobcards">
          {jobs.map(({ job, snapshot, profile }) => (
            <JobCard key={job.id} job={job} snapshot={snapshot} profile={profile} />
          ))}
        </div>
      )}
    </div>
  );
}
