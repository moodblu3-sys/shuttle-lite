import { notFound } from 'next/navigation';
import { ReviewList } from '../../../../components/review-list';
import { buildReviewPage } from '../../../../lib/review';
import { getCatalog, getConfig, getStore } from '../../../../lib/runtime';

export const dynamic = 'force-dynamic';

export default async function ReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ jobId: string }>;
  searchParams: Promise<{ page?: string | string[]; q?: string | string[] }>;
}) {
  const { jobId } = await params;
  const job = getStore().getJob(jobId);
  if (!job) notFound();
  if (job.cleanupState !== 'NONE')
    return (
      <div className="page-content">
        <h1>このテストは終了しています</h1>
        <p>{job.cleanupMessage}</p>
        <a href={`/jobs/${jobId}`}>結果と削除状況を確認</a>
      </div>
    );

  const search = await searchParams;
  const { items, ...pagination } = buildReviewPage(
    jobId,
    Number(Array.isArray(search.page) ? search.page[0] : (search.page ?? 1)),
    (Array.isArray(search.q) ? search.q[0] : search.q) ?? '',
  );
  return (
    <>
      <ReviewList
        key={`${jobId}:${pagination.page}:${pagination.query}`}
        metadataTemplates={getStore().getJobMetadata(jobId) ?? []}
        jobId={jobId}
        items={items}
        pagination={pagination}
        destinations={getCatalog(jobId).entries.map((entry) => ({
          key: entry.key,
          label: entry.label,
          boxPath: entry.boxPath,
        }))}
        needsReviewKey={getCatalog(jobId).needsReviewKey}
        defaultOperatorLabel={job.operatorLabel}
        boxLinkBase={getConfig().box.mode === 'real' ? 'https://app.box.com/file/' : null}
      />
    </>
  );
}
