// A Route Handler, not a page: `cookies().set()` throws
// "Cookies can only be modified in a Server Action or Route Handler" when
// called from a Server Component during render (Next.js's request store
// only marks cookies mutable in the 'action' phase, which page rendering is
// not). Initiating the handshake needs to set the `state` and `verifier`
// cookies before redirecting, so it cannot be the placeholder's page
// component — this replaces it at the same route.
import { buildAuthorizationUrl } from '@keki/auth';
import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { sanitizeNextPath } from '../guards';
import { setOAuthNextCookie, setOAuthStateCookie, setOAuthVerifierCookie } from '../session-cookies';

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Sanitized and stored in its own cookie, not packed into the OAuth
  // `state` parameter — Cognito echoes `state` back verbatim, and a
  // user-controlled value making a round trip through a third party is a
  // temptation to skip re-sanitizing it on return.
  const next = sanitizeNextPath(request.nextUrl.searchParams.get('next'));
  const { url, state, verifier } = buildAuthorizationUrl();

  const store = await cookies();
  setOAuthStateCookie(store, state);
  setOAuthVerifierCookie(store, verifier);
  setOAuthNextCookie(store, next);

  return NextResponse.redirect(url);
}
