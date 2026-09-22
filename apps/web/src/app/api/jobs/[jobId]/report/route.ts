import { buildReportDocument, reportToCsv } from '@shuttle-lite/telemetry';
import { getStore } from '../../../../../lib/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Read-only report download. Uploading the report to Box is a worker command
 * (GENERATE_REPORT), so this endpoint stays a pure read.
 */
export async function GET(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await context.params;
  const store = getStore();
  if (!store.getJob(jobId)) {
    return new Response(JSON.stringify({ error: `jobが存在しません: ${jobId}` }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  const format = new URL(request.url).searchParams.get('format') === 'csv' ? 'csv' : 'json';
  const document = buildReportDocument(store, jobId);
  const body =
    format === 'csv' ? reportToCsv(document.rows) : `${JSON.stringify(document, null, 2)}\n`;

  return new Response(body, {
    headers: {
      'content-type':
        format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="shuttle-lite-${jobId}.${format}"`,
      'cache-control': 'no-store',
    },
  });
}
