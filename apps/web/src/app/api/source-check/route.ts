import { guard } from '../../../lib/auth';
import { NextResponse } from 'next/server';
import { checkSource } from '../../../lib/source-check';
import { isLocalMutation } from '../../../lib/local-request';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
let checking = false;

export async function POST(request: Request) {
  const denied = await guard(request, undefined, false);
  if (denied) return denied;
  if (!isLocalMutation(request, 'x-shuttle-source-check'))
    return NextResponse.json({ error: 'localhostの画面から確認してください。' }, { status: 403 });
  const body = (await request.json().catch(() => null)) as { sourceRootPath?: unknown } | null;
  if (typeof body?.sourceRootPath !== 'string' || body.sourceRootPath.length > 4096)
    return NextResponse.json({ error: '移行元フォルダーを選択してください。' }, { status: 400 });
  if (checking)
    return NextResponse.json(
      { error: '別の確認が実行中です。しばらくしてから再確認してください。' },
      { status: 409 },
    );
  checking = true;
  try {
    return NextResponse.json(await checkSource(body.sourceRootPath, request.signal), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return NextResponse.json({ error: '移行元フォルダーを選び直してください。' }, { status: 400 });
  } finally {
    checking = false;
  }
}
