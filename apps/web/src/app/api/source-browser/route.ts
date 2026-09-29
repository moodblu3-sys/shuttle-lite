import { NextResponse } from 'next/server';
import { guard, requestCookie, SESSION_COOKIE } from '../../../lib/auth';
import { isLocalMutation } from '../../../lib/local-request';
import { browseSource } from '../../../lib/source-browser';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };

export async function POST(request: Request) {
  const denied = await guard(request, undefined, false);
  if (denied) return denied;
  if (!isLocalMutation(request, 'x-shuttle-source-browser'))
    return NextResponse.json(
      { error: 'localhostの画面から開いてください。' },
      { status: 403, headers },
    );
  const body = (await request.json().catch(() => null)) as {
    browseToken?: unknown;
    relativePath?: unknown;
  } | null;
  if (typeof body?.browseToken !== 'string' || typeof body?.relativePath !== 'string')
    return NextResponse.json(
      { error: '移行元フォルダーを選び直してください。' },
      { status: 400, headers },
    );
  try {
    return NextResponse.json(
      await browseSource(
        body.browseToken,
        body.relativePath,
        requestCookie(request, SESSION_COOKIE) ?? 'local',
        request.signal,
      ),
      { headers },
    );
  } catch {
    return NextResponse.json(
      {
        error:
          'フォルダーを開けません。アクセス権・接続を確認し、範囲を小さくして選び直してください。',
      },
      { status: 400, headers },
    );
  }
}
