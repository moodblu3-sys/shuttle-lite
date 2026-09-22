import { NextResponse } from 'next/server';
import { getStore } from '../../../lib/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ jobs: getStore().listJobs() });
}

/**
 * Creates the job row and appends a START_JOB command. The scan and every
 * transfer happen in the worker process, never in this request.
 */
export async function POST(request: Request) {
  const body = (await request.json()) as Record<string, unknown>;
  const profileId = typeof body.profileId === 'string' ? body.profileId : '';
  const operatorLabel =
    typeof body.operatorLabel === 'string' && body.operatorLabel.trim().length > 0
      ? body.operatorLabel.trim()
      : '';
  if (profileId.length === 0 || operatorLabel.length === 0) {
    return NextResponse.json({ error: 'profileId と operatorLabel は必須です' }, { status: 400 });
  }

  const store = getStore();
  if (!store.getProfile(profileId)) {
    return NextResponse.json({ error: `profileが存在しません: ${profileId}` }, { status: 404 });
  }

  const job = store.createJob({ profileId, operatorLabel });
  if (body.autoStart !== false) store.enqueueCommand(job.id, 'START_JOB');
  return NextResponse.json({ job }, { status: 201 });
}
