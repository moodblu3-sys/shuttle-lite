import { guard, currentUser } from '../../../../../lib/auth';
import { NextResponse } from 'next/server';
import { COMMAND_TYPES, type CommandType } from '@shuttle-lite/core';
import { getStore } from '../../../../../lib/runtime';
import { isDatabaseBusy } from '@shuttle-lite/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ jobId: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  const { jobId } = await context.params;
  const denied = await guard(_request, jobId);
  if (denied) return denied;
  return NextResponse.json({ commands: getStore().listCommands(jobId) });
}

/**
 * The only write path exposed to the browser: append a command. Validation of
 * intent happens here, but the decision to act stays with the worker.
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    return await appendCommand(request, context);
  } catch (error) {
    if (isDatabaseBusy(error)) {
      return NextResponse.json(
        {
          code: 'DATABASE_BUSY',
          error: '処理が混み合っています。少し待ってから再操作してください。',
        },
        { status: 503, headers: { 'Retry-After': '1' } },
      );
    }
    // Preserve the server diagnostic for unexpected failures. The client also
    // handles non-JSON error responses without exposing a JSON parser error.
    throw error;
  }
}

async function appendCommand(request: Request, context: RouteContext) {
  const { jobId } = await context.params;
  const denied = await guard(request, jobId);
  if (denied) return denied;
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

  const user = await currentUser(request);
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
    return (
      existing ??
      store.enqueueCommand(
        jobId,
        type,
        user
          ? { ...body.payload, operatorLabel: user.name, actorUserId: user.id }
          : (body.payload ?? {}),
        user?.id,
      )
    );
  });
  return NextResponse.json({ command }, { status: 202 });
}
