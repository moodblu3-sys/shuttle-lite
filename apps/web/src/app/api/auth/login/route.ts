import { NextResponse } from 'next/server';
import {
  authStore,
  boxOAuth,
  cookieOptions,
  oauthEnabled,
  STATE_COOKIE,
} from '../../../../lib/auth';
import { getConfig } from '../../../../lib/runtime';

export const runtime = 'nodejs';
export async function GET(request: Request) {
  if (!oauthEnabled()) return NextResponse.redirect(new URL('/', getConfig().env.SHUTTLE_APP_URL));
  if (request && new URL(request.url).origin !== new URL(getConfig().env.SHUTTLE_APP_URL).origin)
    return NextResponse.redirect(new URL('/api/auth/login', getConfig().env.SHUTTLE_APP_URL));
  const state = authStore().createState();
  const response = NextResponse.redirect(boxOAuth().authorizationUrl(state));
  response.cookies.set(STATE_COOKIE, state, cookieOptions(300));
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
