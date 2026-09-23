import { NextResponse } from 'next/server';
import { buildReviewViews } from '../../../../../lib/review';
import { getCatalog, getStore } from '../../../../../lib/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await context.params;
  if (!getStore().getJob(jobId)) {
    return NextResponse.json({ error: `jobが存在しません: ${jobId}` }, { status: 404 });
  }
  return NextResponse.json({
    items: buildReviewViews(jobId),
    metadataTemplates: getStore().getJobMetadata(jobId) ?? [],
    destinations: getCatalog(jobId).entries.map((entry) => ({
      key: entry.key,
      label: entry.label,
      boxPath: entry.boxPath,
    })),
  });
}
