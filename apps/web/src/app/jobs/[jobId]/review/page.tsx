import { notFound } from 'next/navigation';
import { ReviewList } from '../../../../components/review-list';
import { buildReviewViews } from '../../../../lib/review';
import { getCatalog, getConfig, getStore } from '../../../../lib/runtime';

export const dynamic = 'force-dynamic';

export default async function ReviewPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const job = getStore().getJob(jobId);
  if (!job) notFound();

  return (
    <>
      <ReviewList
        key={jobId}
        jobId={jobId}
        items={buildReviewViews(jobId)}
        destinations={getCatalog().entries.map((entry) => ({
          key: entry.key,
          label: entry.label,
          boxPath: entry.boxPath,
        }))}
        needsReviewKey={getCatalog().needsReviewKey}
        defaultOperatorLabel={job.operatorLabel}
        boxLinkBase={getConfig().box.mode === 'real' ? 'https://app.box.com/file/' : null}
      />
    </>
  );
}
