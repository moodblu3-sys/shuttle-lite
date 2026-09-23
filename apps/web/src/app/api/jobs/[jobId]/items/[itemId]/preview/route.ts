import { NextResponse } from 'next/server';
import { createFilePreview, filePreviewError } from '../../../../../../../lib/file-preview';
import { isLocalMutation } from '../../../../../../../lib/local-request';
import { getBoxGateway, getStore } from '../../../../../../../lib/runtime';

export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'no-store' };

export async function POST(
  request: Request,
  context: { params: Promise<{ jobId: string; itemId: string }> },
) {
  if (!isLocalMutation(request, 'x-shuttle-preview'))
    return NextResponse.json(
      { code: 'FORBIDDEN', message: 'この画面からプレビューを開いてください' },
      { status: 403, headers },
    );
  try {
    const { jobId, itemId } = await context.params;
    const body: unknown = await request.json().catch(() => null);
    const preview = await createFilePreview(
      getStore(),
      getBoxGateway(),
      jobId,
      itemId,
      body,
      AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]),
    );
    return NextResponse.json(preview, { headers });
  } catch (cause) {
    const error = filePreviewError(cause);
    return NextResponse.json(
      { code: error.code, message: error.message },
      {
        status: error.status,
        headers: {
          ...headers,
          ...(error.retryAfterSeconds ? { 'Retry-After': String(error.retryAfterSeconds) } : {}),
        },
      },
    );
  }
}
