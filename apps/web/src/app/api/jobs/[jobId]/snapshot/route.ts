import { NextResponse } from 'next/server';
import { buildJobSnapshot } from '@shuttle-lite/telemetry';
import { getStore } from '../../../../../lib/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await context.params;
  const snapshot = buildJobSnapshot(getStore(), jobId);
  if (!snapshot) {
    return NextResponse.json({ error: `jobが存在しません: ${jobId}` }, { status: 404 });
  }
  return NextResponse.json(snapshot);
}
