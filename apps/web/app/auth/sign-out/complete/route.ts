import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { clearSessionCookies } from '../../session-cookies';

/**
 * Where Cognito lands the browser after `/logout` completes. Clears the
 * cookies again defensively — a user can arrive here directly, without ever
 * having gone through `/auth/sign-out` — and returns home.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const store = await cookies();
  clearSessionCookies(store);
  return NextResponse.redirect(new URL('/', request.url));
}
