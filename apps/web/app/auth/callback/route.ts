import { exchangeCodeForTokens, OAuthExchangeError } from '@keki/auth';
import { timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { sanitizeNextPath } from '../guards';
import {
  clearHandshakeCookies,
  OAUTH_NEXT_COOKIE_NAME,
  OAUTH_STATE_COOKIE_NAME,
  OAUTH_VERIFIER_COOKIE_NAME,
  setIdTokenCookie,
  setRefreshTokenCookie,
} from '../session-cookies';

const SIGN_IN_PATH = '/auth/sign-in';
const DEFAULT_NEXT_PATH = '/book';

/**
 * Compares the query's `state` against the cookie's in constant time. This
 * is the CSRF boundary of the handshake: an unvalidated callback lets an
 * attacker complete a sign-in against a victim's browser, so the comparison
 * itself must not leak timing information about how much of the value
 * matched.
 */
function statesMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const signInUrl = new URL(SIGN_IN_PATH, request.url);
  const { searchParams } = request.nextUrl;
  const code = searchParams.get('code');
  const error = searchParams.get('error');
  const state = searchParams.get('state');

  const store = await cookies();
  const cookieState = store.get(OAUTH_STATE_COOKIE_NAME)?.value ?? null;
  const verifier = store.get(OAUTH_VERIFIER_COOKIE_NAME)?.value ?? null;
  const storedNext = store.get(OAUTH_NEXT_COOKIE_NAME)?.value ?? null;

  // Cognito sends `error` instead of `code` when the user cancelled or the
  // client is misconfigured. Treat it the same as any other reason there is
  // no code to exchange, rather than crashing on a missing parameter.
  if (error !== null || code === null) {
    return NextResponse.redirect(signInUrl);
  }

  // Abort before any token exchange: a missing or mismatched state is
  // refused first, on principle, not just as an optimization.
  if (state === null || cookieState === null || !statesMatch(state, cookieState)) {
    return NextResponse.redirect(signInUrl);
  }

  if (verifier === null) {
    return NextResponse.redirect(signInUrl);
  }

  let tokens;
  try {
    tokens = await exchangeCodeForTokens({ code, verifier });
  } catch (caught) {
    if (caught instanceof OAuthExchangeError) {
      // An authorization code is single-use, so the commonest cause here is
      // a refresh or a back-button replay, not an attack — a generic
      // redirect back to sign-in is the right response either way.
      return NextResponse.redirect(signInUrl);
    }
    throw caught;
  }

  setIdTokenCookie(store, tokens.id_token);
  if (tokens.refresh_token !== undefined) {
    setRefreshTokenCookie(store, tokens.refresh_token);
  }
  // Spent the moment the exchange succeeds; a retained verifier is a replay
  // surface.
  clearHandshakeCookies(store);

  const destination = storedNext !== null ? sanitizeNextPath(storedNext) : DEFAULT_NEXT_PATH;
  return NextResponse.redirect(new URL(destination, request.url));
}
