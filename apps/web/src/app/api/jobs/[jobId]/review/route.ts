import { NextResponse } from 'next/server';
import { buildReviewPage } from '../../../../../lib/review';
import { getCatalog, getStore } from '../../../../../lib/runtime';
import type { SavedReviewDraft } from '../../../../../lib/review-drafts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await context.params;
  if (!getStore().getJob(jobId)) {
    return NextResponse.json({ error: `jobが存在しません: ${jobId}` }, { status: 404 });
  }
  const search = new URL(request.url).searchParams;
  return NextResponse.json({
    ...buildReviewPage(
      jobId,
      Number(search.get('page') ?? 1),
      search.get('q') ?? '',
      search.get('filter') ?? 'all',
    ),
    metadataTemplates: getStore().getAvailableJobMetadata(jobId),
    destinations: getCatalog(jobId).entries.map((entry) => ({
      key: entry.key,
      label: entry.label,
      boxPath: entry.boxPath,
    })),
  });
}

/** Read-only query: browser drafts affect filtering, never persisted routing or approval. */
export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await context.params;
  if (!getStore().getJob(jobId))
    return NextResponse.json({ error: '移行が見つかりません。' }, { status: 404 });
  let input: { page?: number; query?: string; filter?: string; drafts?: SavedReviewDraft[] };
  try {
    input = (await request.json()) as typeof input;
    if (
      !input ||
      typeof input !== 'object' ||
      !Array.isArray(input.drafts) ||
      (input.query !== undefined && typeof input.query !== 'string') ||
      (input.filter !== undefined && typeof input.filter !== 'string')
    )
      throw new Error('invalid query');
  } catch {
    return NextResponse.json({ error: '検索条件を確認してください。' }, { status: 400 });
  }
  return NextResponse.json({
    ...buildReviewPage(
      jobId,
      input.page ?? 1,
      input.query ?? '',
      input.filter ?? 'all',
      input.drafts,
    ),
    metadataTemplates: getStore().getAvailableJobMetadata(jobId),
  });
}
