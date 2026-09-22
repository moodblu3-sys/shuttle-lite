import { notFound } from 'next/navigation';
import { buildJobSnapshot } from '@shuttle-lite/telemetry';
import { JobIdentity } from '../../../components/job-card';
import { ProgressView } from '../../../components/progress-view';
import { getConfig, getStore } from '../../../lib/runtime';

export const dynamic = 'force-dynamic';

export default async function JobPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const store = getStore();
  const snapshot = buildJobSnapshot(store, jobId);
  if (!snapshot) notFound();
  const profile = store.getProfile(snapshot.job.profileId);
  const destinations = store.getJobDestinations(jobId);

  return (
    <div className="page-content">
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

      {destinations ? (
        <p className="small muted">
          移行先：{destinations.rootFolderName}（選択時の既存フォルダー{' '}
          {destinations.entries.length}件）
        </p>
      ) : getConfig().box.mode === 'real' ? (
        <p className="error">
          この移行にはBoxの移行先が設定されていません。「新しい移行」で移行先を選択してください。既存のファイルと履歴は残っています。
        </p>
      ) : null}

      {snapshot.job.lastError ? (
        <p className="error">
          {snapshot.job.lastErrorCategory}: {snapshot.job.lastError}
        </p>
      ) : null}

      <ProgressView jobId={jobId} initial={snapshot} />
    </div>
  );
}
