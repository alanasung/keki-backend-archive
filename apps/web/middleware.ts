// Imported from the `/cookies` subpath, not the package root: the root
// barrel re-exports `resolveSession` and `findProfileByCognitoSub`, which
// pull in `@keki/database` at module-evaluation time. That import chain
// needs a Node runtime and real connection strings — exactly what this
// Edge-runtime file cannot have. The subpath keeps this file's dependency
// graph limited to the pure cookie parser it actually needs.
import { extractToken } from '@keki/auth/cookies';
import { NextResponse, type NextRequest } from 'next/server';

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
 */
const PROTECTED_PREFIXES = ['/staff', '/admin'];

function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  if (isProtectedPath(pathname)) {
    const token = extractToken(request.headers.get('cookie'));
    if (token === null) {
      const signInUrl = new URL('/auth/sign-in', request.url);
      signInUrl.searchParams.set('next', pathname);
      return NextResponse.redirect(signInUrl);
    }
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-pathname', pathname);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|auth/).*)'],
};
