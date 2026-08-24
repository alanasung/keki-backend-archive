// Imported from the `/cookies` subpath, not the package root: the root
// barrel re-exports `resolveSession` and `findProfileByCognitoSub`, which
// pull in `@keki/database` at module-evaluation time. That import chain
// needs a Node runtime and real connection strings — exactly what this
// Edge-runtime file cannot have. The subpath keeps this file's dependency
// graph limited to the pure cookie parser it actually needs.
import { extractToken } from '@keki/auth/cookies';
// `/oauth` is a second, narrower subpath of the same package: `oauth.ts`
// only depends on `env.ts`/`oauth-env.ts`/`errors.ts` and `@keki/contracts`,
// none of which touch `@keki/database`, so it is safe on the Edge runtime
// the same way `/cookies` is.
import { refreshSession, shouldRefresh } from '@keki/auth/oauth';
import { NextResponse, type NextRequest } from 'next/server';
import {
  clearSessionCookies,
  REFRESH_TOKEN_COOKIE_NAME,
  REFRESHED_ID_TOKEN_HEADER,
  setIdTokenCookie,
} from './app/auth/session-cookies';

/**
 * This middleware has exactly two responsibilities and must never grow a
 * third:
 *
 *   1. Stamp `x-pathname` on every matched request so layouts can compute
 *      the active nav item without threading the pathname through props.
 *   2. Redirect obviously-anonymous requests to `/staff` or `/admin` before
 *      they render, as a fast path — not as the authorization boundary.
 *
 * It CANNOT be the authorization boundary. Middleware runs on the Edge
 * runtime, which cannot open a Neon Postgres connection — `@keki/database`
 * needs a Node runtime — so this code can never see the Postgres-held role.
 * A gate that cannot see the role cannot enforce one; it can only check
 * whether a session cookie exists at all. The real, role-aware check lives
 * in `app/auth/guards.ts` (`requireRole`), which runs in the Node runtime on
 * every protected layout. Do not "helpfully" move authorization here — that
 * would require Edge-compatible database access this project does not have.
 *
 * WS-04 adds a third, narrow exception: refreshing a near-expired id token.
 * That has to happen somewhere a *response* is being produced, because
 * `cookies().set()` throws when called from a Server Component during
 * render (Next.js only allows cookie mutation in the 'action' phase — a
 * Server Action or Route Handler — not while rendering a page or layout).
 * Every protected and public page alike needs its session kept fresh, and
 * no single Route Handler runs ahead of all of them, so middleware — which
 * already runs on nearly every request via this file's matcher — is the
 * only place a response is being produced for every one of them. This is
 * the one purpose-built exception to "middleware has exactly two
 * responsibilities"; it is not a foothold for adding real authorization
 * logic here.
 */
const PROTECTED_PREFIXES = ['/staff', '/admin'];

function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function extractCookieValue(cookieHeader: string | null, name: string): string | null {
  if (cookieHeader === null) {
    return null;
  }
  for (const pair of cookieHeader.split(';')) {
    const separatorIndex = pair.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }
    const cookieName = pair.slice(0, separatorIndex).trim();
    if (cookieName !== name) {
      continue;
    }
    const value = pair.slice(separatorIndex + 1).trim();
    return value.length > 0 ? decodeURIComponent(value) : null;
  }
  return null;
}

/**
 * Reads the `exp` claim without verifying the token — only for deciding
 * whether a refresh is worth attempting. The token that actually resolves
 * the session is still verified properly, downstream, by `resolveSession`;
 * a forged or malformed token here just fails to decode and skips the
 * refresh, exactly as if it were near-expiry-but-fine.
 */
function decodeIdTokenExpiry(jwt: string): Date | null {
  const segments = jwt.split('.');
  const payloadSegment = segments[1];
  if (segments.length !== 3 || payloadSegment === undefined) {
    return null;
  }
  try {
    const base64 = payloadSegment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    const payload: unknown = JSON.parse(atob(padded));
    const exp = typeof payload === 'object' && payload !== null && 'exp' in payload ? payload.exp : undefined;
    return typeof exp === 'number' ? new Date(exp * 1000) : null;
  } catch {
    return null;
  }
}

interface RefreshOutcome {
  readonly token: string | null;
  readonly newIdToken: string | null;
  readonly failed: boolean;
}

/**
 * Refreshes the id token when it is near expiry and a refresh token is
 * available. A failed refresh signs the user out rather than retrying — a
 * refresh token is rejected because the session is over, and retrying would
 * convert one failure into a loop.
 */
async function maybeRefresh(cookieHeader: string | null): Promise<RefreshOutcome> {
  const token = extractToken(cookieHeader);
  if (token === null) {
    return { token: null, newIdToken: null, failed: false };
  }

  const expiresAt = decodeIdTokenExpiry(token);
  if (expiresAt === null || !shouldRefresh(expiresAt, new Date())) {
    return { token, newIdToken: null, failed: false };
  }

  const refreshToken = extractCookieValue(cookieHeader, REFRESH_TOKEN_COOKIE_NAME);
  if (refreshToken === null) {
    return { token, newIdToken: null, failed: false };
  }

  try {
    const tokens = await refreshSession({ refreshToken });
    return { token: tokens.id_token, newIdToken: tokens.id_token, failed: false };
  } catch {
    return { token: null, newIdToken: null, failed: true };
  }
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;
  const outcome = await maybeRefresh(request.headers.get('cookie'));

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-pathname', pathname);
  if (outcome.newIdToken !== null) {
    // Forwarded so `getSessionResult` sees the refreshed session on this
    // same request, rather than only on the browser's next one.
    requestHeaders.set(REFRESHED_ID_TOKEN_HEADER, outcome.newIdToken);
  }

  if (isProtectedPath(pathname) && outcome.token === null) {
    const signInUrl = new URL('/auth/sign-in', request.url);
    signInUrl.searchParams.set('next', pathname);
    return NextResponse.redirect(signInUrl);
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  if (outcome.newIdToken !== null) {
    setIdTokenCookie(response.cookies, outcome.newIdToken);
  } else if (outcome.failed) {
    clearSessionCookies(response.cookies);
  }
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|auth/).*)'],
};
