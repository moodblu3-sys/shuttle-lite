import { guard, requestCookie, SESSION_COOKIE } from '../../../lib/auth';
import { NextResponse } from 'next/server';
import { chooseSourceFolder, FolderPickerError } from '../../../lib/folder-picker';
import { grantSourceBrowse } from '../../../lib/source-browser';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function isLocalPickerRequest(request: Request): boolean {
  try {
    const url = new URL(request.url);
    const host = request.headers.get('host') ?? url.host;
    const local = new URL(`${url.protocol}//${host}`);
    const origin = new URL(request.headers.get('origin') ?? '');
    return (
      ['localhost', '127.0.0.1', '[::1]'].includes(local.hostname) &&
      origin.origin === local.origin &&
      request.headers.get('x-shuttle-folder-picker') === '1' &&
      (!request.headers.has('sec-fetch-site') ||
        request.headers.get('sec-fetch-site') === 'same-origin')
    );
  } catch {
    return false;
  }
}

/** Only returns the chosen folder. Job creation and file transfer are separate actions. */
export async function POST(request: Request) {
  const denied = await guard(request, undefined, false);
  if (denied) return denied;
  if (!isLocalPickerRequest(request)) {
    return NextResponse.json(
      { error: 'アプリを起動したMacでlocalhostの画面を開き、フォルダーを選択してください。' },
      { status: 403 },
    );
  }
  try {
    const url = new URL(request.url);
    const selection = await chooseSourceFolder(
      request.signal,
      url.searchParams.get('purpose') === 'logs' ? 'logs' : 'source',
    );
    const browse =
      !selection.cancelled &&
      url.searchParams.get('browse') === '1' &&
      url.searchParams.get('purpose') !== 'logs'
        ? await grantSourceBrowse(selection.path, requestCookie(request, SESSION_COOKIE) ?? 'local')
        : {};
    return NextResponse.json(
      { ...selection, ...browse },
      {
        headers: { 'Cache-Control': 'no-store' },
      },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof FolderPickerError ? error.message : 'フォルダーを選択できませんでした。',
      },
      { status: error instanceof FolderPickerError ? error.status : 500 },
    );
  }
}
