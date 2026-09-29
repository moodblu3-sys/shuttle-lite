import { requirePageUser } from '../../../../lib/auth';
import { notFound, redirect } from 'next/navigation';
import { DeltaControls } from '../../../../components/delta-controls';
import { getStore } from '../../../../lib/runtime';

export const dynamic = 'force-dynamic';

export default async function DeltaPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  await requirePageUser(jobId);
  const job = getStore().getJob(jobId);
  if (!job) notFound();
  if (job.migrationMode !== 'AS_IS') redirect(`/jobs/${jobId}`);
  return (
    <div className="page-content">
      <p className="breadcrumb">
        <a href="/">移行一覧</a> / 差分移行
      </p>
      <h1 className="page-title">{job.name}</h1>
      {job.testMode ? (
        <section className="card">
          <h2>差分移行</h2>
          <p>テストモードでは差分移行できません。</p>
        </section>
      ) : (
        <DeltaControls jobId={jobId} showHistory={false} />
      )}
    </div>
  );
}
