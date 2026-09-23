import { NextResponse } from 'next/server';
import { buildReviewPage } from '../../../../../lib/review';
import { getCatalog, getStore } from '../../../../../lib/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await context.params;
  if (!getStore().getJob(jobId)) {
    return NextResponse.json({ error: `jobが存在しません: ${jobId}` }, { status: 404 });
  }
  const search = new URL(request.url).searchParams;
  return NextResponse.json({
    ...buildReviewPage(jobId, Number(search.get('page') ?? 1), search.get('q') ?? ''),
    metadataTemplates: getStore().getJobMetadata(jobId) ?? [],
    destinations: getCatalog(jobId).entries.map((entry) => ({
      key: entry.key,
      label: entry.label,
      boxPath: entry.boxPath,
    })),
  });
}
