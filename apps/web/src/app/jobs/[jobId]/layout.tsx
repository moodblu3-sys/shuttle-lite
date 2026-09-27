import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { JobNavigation } from '../../../components/job-navigation';
import { getStore } from '../../../lib/runtime';

export const dynamic = 'force-dynamic';

export default async function JobLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ jobId: string }>;
}) {
  const { jobId } = await params;
  const job = getStore().getJob(jobId);
  if (!job) notFound();
  return (
    <div className="job-workspace">
      <JobNavigation jobId={jobId} mode={job.migrationMode} />
      <div className="job-content">{children}</div>
    </div>
  );
}
