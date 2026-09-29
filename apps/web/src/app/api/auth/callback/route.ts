import { NextResponse } from 'next/server';
import {
  authStore,
  boxOAuth,
  cookieOptions,
  oauthEnabled,
  requestCookie,
  SESSION_COOKIE,
  STATE_COOKIE,
} from '../../../../lib/auth';
import { getConfig } from '../../../../lib/runtime';

export const runtime = 'nodejs';
export async function GET(request: Request) {
  const origin = getConfig().env.SHUTTLE_APP_URL;
  const failed = () => NextResponse.redirect(new URL('/login?error=oauth', origin));
  if (!oauthEnabled()) return failed();
  const url = new URL(request.url);
  const valid = authStore().consumeState(
    url.searchParams.get('state') ?? '',
    requestCookie(request, STATE_COOKIE),
  );
  let response: NextResponse;
  try {
    const code = url.searchParams.get('code');
    if (!valid || !code || url.searchParams.has('error')) throw new Error('invalid callback');
    const user = await boxOAuth().authorize(code);
    const previous = requestCookie(request, SESSION_COOKIE);
    if (previous) authStore().deleteSession(previous);
    response = NextResponse.redirect(new URL('/', origin));
    response.cookies.set(
      SESSION_COOKIE,
      authStore().createSession(user.id),
      cookieOptions(12 * 60 * 60),
    );
  } catch {
    response = failed();
  }
  response.cookies.set(STATE_COOKIE, '', cookieOptions(0));
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}
