import { buildSignOutUrl } from '@keki/auth';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { clearSessionCookies } from '../session-cookies';

/**
 * Clears the local session, then hands off to Cognito's own logout endpoint.
 * Clearing only the local cookie leaves the Cognito session alive — the
 * next sign-in would silently reuse it, and the user would appear never to
 * have signed out.
 */
export async function GET(): Promise<NextResponse> {
  const store = await cookies();
  clearSessionCookies(store);
  return NextResponse.redirect(buildSignOutUrl());
}
