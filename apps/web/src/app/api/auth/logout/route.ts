import { NextResponse } from 'next/server';
import {
  authStore,
  cookieOptions,
  guard,
  oauthEnabled,
  requestCookie,
  SESSION_COOKIE,
} from '../../../../lib/auth';
import { getConfig } from '../../../../lib/runtime';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  const denied = await guard(request);
  if (denied) return denied;
  const token = requestCookie(request, SESSION_COOKIE);
  if (oauthEnabled() && token) authStore().deleteSession(token);
  const response = NextResponse.redirect(new URL('/login', getConfig().env.SHUTTLE_APP_URL), 303);
  response.cookies.set(SESSION_COOKIE, '', cookieOptions(0));
  return response;
}
