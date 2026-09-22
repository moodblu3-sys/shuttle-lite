import { buildJobSnapshot } from '@shuttle-lite/telemetry';
import { getStore } from '../../../../../lib/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POLL_INTERVAL_MS = 1_000;

/**
 * Server-sent progress. This handler only reads the projection from SQLite on
 * a timer; the migration itself runs in the worker, so nothing long running
 * happens inside the request (docs/decisions.md D-003).
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

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const push = () => {
        if (closed) return;
        try {
          const snapshot = buildJobSnapshot(store, jobId);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(snapshot)}\n\n`));
        } catch {
          // A transient read error must not kill the stream.
        }
      };
      const timer = setInterval(push, POLL_INTERVAL_MS);
      const stop = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        try {
          controller.close();
        } catch {
          // Already closed by the client.
        }
      };
      request.signal.addEventListener('abort', stop);
      push();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
    },
  });
}
