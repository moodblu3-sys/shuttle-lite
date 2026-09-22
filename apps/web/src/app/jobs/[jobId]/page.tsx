import { notFound } from 'next/navigation';
import { buildJobSnapshot } from '@shuttle-lite/telemetry';
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

      <ProgressView jobId={jobId} initial={snapshot} profile={profile}>
        {destinations ? (
          <p className="small muted">
            移行先：{destinations.rootFolderName}（フォルダー {destinations.entries.length}件）
          </p>
        ) : getConfig().box.mode === 'real' ? (
          <p className="error">移行先が未設定です。「新しい移行」で移行先を指定してください。</p>
        ) : null}
      </ProgressView>
    </div>
  );
}
