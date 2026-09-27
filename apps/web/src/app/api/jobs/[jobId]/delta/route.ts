import { NextResponse } from 'next/server';
import { getDeltaPlan, migrationRuns } from '@shuttle-lite/db';
import { getStore } from '../../../../../lib/runtime';
export const dynamic = 'force-dynamic';
export async function GET(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const store = getStore();
  if (!store.getJob(jobId))
    return NextResponse.json({ error: '移行が見つかりません。' }, { status: 404 });
  const runs = migrationRuns(store, jobId);
  const commands = runs
    .flatMap((r) => store.listJobOperations(r.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const pending = commands.some((c) => c.state === 'PENDING' || c.state === 'CLAIMED');
  const eligible =
    runs.every((r) => ['COMPLETED', 'FAILED'].includes(r.state) && r.cleanupState === 'NONE') &&
    !pending;
  return NextResponse.json({
    runs,
    eligible,
    commands: commands
      .filter((c) => c.type === 'CHECK_DELTA' || c.type === 'START_DELTA')
      .slice(0, 10),
    plan: getDeltaPlan(store, jobId),
  });
}
