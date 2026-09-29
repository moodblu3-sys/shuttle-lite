import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { NextResponse } from 'next/server';
import { AuthStore } from '@shuttle-lite/db';
import type { AuthUser } from '@shuttle-lite/core';
import { BoxOAuth } from '@shuttle-lite/box';
import { getConfig, getStore } from './runtime';

export const SESSION_COOKIE = 'shuttle_session';
export const STATE_COOKIE = 'shuttle_oauth_state';
export const oauthEnabled = () => getConfig().env.BOX_AUTH_MODE === 'oauth';
export const authStore = () => new AuthStore(getStore().db, getConfig().env.SHUTTLE_AUTH_KEY!);
let oauth: BoxOAuth | undefined;
export const boxOAuth = () => (oauth ??= new BoxOAuth(getConfig(), authStore()));
export async function browsingConfig() {
  if (!oauthEnabled()) return getConfig();
  const user = await currentUser();
  if (!user) throw new Error('Boxにログインしてください。');
  return boxOAuth().userConfig(user.id);
}
export const isAdmin = (user: AuthUser | null) =>
  !oauthEnabled() ||
  (!!user &&
    getConfig()
      .env.SHUTTLE_ADMIN_USER_IDS.split(',')
      .map((id) => id.trim())
      .includes(user.id));

export function requestCookie(request: Request, name: string): string | undefined {
  return request.headers
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

export async function currentUser(request?: Request): Promise<AuthUser | null> {
  if (!oauthEnabled()) return null;
  const token = request
    ? requestCookie(request, SESSION_COOKIE)
    : (await cookies()).get(SESSION_COOKIE)?.value;
  const user = authStore().session(token);
  return user?.enterpriseId === getConfig().box.enterpriseId ? user : null;
}

export async function requirePageUser(jobId?: string): Promise<AuthUser | null> {
  const user = await currentUser();
  if (!oauthEnabled()) return null;
  if (!user) redirect('/login');
  if (jobId && getStore().jobOwner(jobId) !== user.id) notFound();
  return user;
}

export function sameOrigin(request: Request): boolean {
  const expected = new URL(getConfig().env.SHUTTLE_APP_URL).origin;
  const url = new URL(request.url);
  if (
    url.origin !== expected ||
    (request.headers.get('host') && request.headers.get('host') !== url.host)
  )
    return false;
  return (
    request.headers.get('origin') === expected &&
    (!request.headers.has('sec-fetch-site') ||
      request.headers.get('sec-fetch-site') === 'same-origin')
  );
}

/** Every data route checks authentication; page layouts alone do not protect APIs or RSC pages. */
export async function guard(
  request?: Request,
  jobId?: string,
  admin = false,
): Promise<NextResponse | null> {
  if (!oauthEnabled()) return null;
  if (request && !['GET', 'HEAD'].includes(request.method) && !sameOrigin(request))
    return NextResponse.json(
      { error: '操作元を確認できません。画面を開き直してください。' },
      { status: 403 },
    );
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: 'Boxにログインしてください。' }, { status: 401 });
  if (admin && !isAdmin(user))
    return NextResponse.json({ error: '管理者のみ操作できます。' }, { status: 403 });
  if (jobId && getStore().jobOwner(jobId) !== user.id)
    return NextResponse.json({ error: '移行が見つかりません。' }, { status: 404 });
  return null;
}

export function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: new URL(getConfig().env.SHUTTLE_APP_URL).protocol === 'https:',
    sameSite: 'lax' as const,
    path: '/',
    maxAge,
  };
}
