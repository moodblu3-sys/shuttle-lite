import { notFound } from 'next/navigation';
import { buildJobSnapshot } from '@shuttle-lite/telemetry';
import { JobIdentity } from '../../../components/job-card';
import { ProgressView } from '../../../components/progress-view';
import { getStore } from '../../../lib/runtime';

export const dynamic = 'force-dynamic';

export default async function JobPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const store = getStore();
  const snapshot = buildJobSnapshot(store, jobId);
  if (!snapshot) notFound();
  const profile = store.getProfile(snapshot.job.profileId);

  return (
    <>
      <p className="breadcrumb">
        <a href="/">移行一覧</a> / 進捗
      </p>

      <div className="jobcard job-head">
        <div className="jobcard-main">
          <JobIdentity job={snapshot.job} snapshot={snapshot} profile={profile} />
          {/* Identifiers are for troubleshooting, not for reading at a glance. */}
          <details className="job-ids">
            <summary className="small muted">ID</summary>
            <dl className="kv small">
              <dt>Job</dt>
              <dd className="mono">{jobId}</dd>
              <dt>Staging folder</dt>
              <dd className="mono">{snapshot.job.stagingFolderId ?? '未作成'}</dd>
            </dl>
          </details>
        </div>
        <p className="small muted jobcard-note">
          操作者 {snapshot.job.operatorLabel} ・ 移行元{' '}
          <span className="mono">{profile?.sourceRootPath ?? '-'}</span>
        </p>
      </div>

      {snapshot.job.lastError ? (
        <p className="error">
          {snapshot.job.lastErrorCategory}: {snapshot.job.lastError}
        </p>
      ) : null}

      <ProgressView jobId={jobId} initial={snapshot} />
    </>
  );
}
