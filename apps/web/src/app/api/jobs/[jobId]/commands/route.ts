import { NextResponse } from 'next/server';
import { COMMAND_TYPES, type CommandType } from '@shuttle-lite/core';
import { getStore } from '../../../../../lib/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ jobId: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  const { jobId } = await context.params;
  return NextResponse.json({ commands: getStore().listCommands(jobId) });
}

/**
 * The only write path exposed to the browser: append a command. Validation of
 * intent happens here, but the decision to act stays with the worker.
 */
export async function POST(request: Request, context: RouteContext) {
  const { jobId } = await context.params;
  const store = getStore();
  if (!store.getJob(jobId)) {
    return NextResponse.json({ error: `jobが存在しません: ${jobId}` }, { status: 404 });
  }

  const input: unknown = await request.json().catch(() => null);
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return NextResponse.json({ error: '操作の指定を確認してください。' }, { status: 400 });
  const body = input as { type?: string; payload?: Record<string, unknown> };
  const type = body.type as CommandType | undefined;
  if (!type || !COMMAND_TYPES.includes(type)) {
    return NextResponse.json(
      { error: `不正なcommand typeです。許可: ${COMMAND_TYPES.join(', ')}` },
      { status: 400 },
    );
  }

  const job = store.getJob(jobId)!;
  if (type === 'END_TEST' && !job.testMode) {
    return NextResponse.json(
      { error: '通常の移行ではテスト終了を実行できません。' },
      { status: 409 },
    );
  }
  if (job.cleanupState !== 'NONE' && type !== 'END_TEST') {
    return NextResponse.json(
      { error: '終了したテストは再開できません。新しい移行を作成してください。' },
      { status: 409 },
    );
  }
  const command = store.transaction(() => {
    const existing = store
      .listJobOperations(jobId)
      .find(
        (command) =>
          command.type === type && (command.state === 'PENDING' || command.state === 'CLAIMED'),
      );
    return existing ?? store.enqueueCommand(jobId, type, body.payload ?? {});
  });
  return NextResponse.json({ command }, { status: 202 });
}
