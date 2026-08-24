// The one place every auth cookie's attributes are decided. Three routes
// (sign-in, callback, sign-out) and middleware all write a subset of these
// four cookies; scattering `httpOnly`/`sameSite`/`secure` literals across
// each one is how a cookie quietly ends up non-`httpOnly`. See WS-04 spec
// step 1.
import { ID_TOKEN_COOKIE_NAME } from '@keki/auth/cookies';

export { ID_TOKEN_COOKIE_NAME };
export const REFRESH_TOKEN_COOKIE_NAME = 'keki_refresh_token';
export const OAUTH_STATE_COOKIE_NAME = 'keki_oauth_state';
export const OAUTH_VERIFIER_COOKIE_NAME = 'keki_oauth_verifier';
export const OAUTH_NEXT_COOKIE_NAME = 'keki_oauth_next';

// Set by `middleware.ts` on a request whose id token it silently refreshed,
// and read by `require-session.ts`. A Server Component cannot write the
// refreshed cookie itself (see middleware.ts), so this header is how the
// refreshed token reaches the same request's session resolution instead of
// waiting for the browser's next request to pick up the new cookie.
export const REFRESHED_ID_TOKEN_HEADER = 'x-keki-refreshed-id-token';

const ID_TOKEN_MAX_AGE_SECONDS = 60 * 60 * 2;
const REFRESH_TOKEN_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
// The handshake cookies only need to survive the round trip to Cognito's
// hosted UI and back; 10 minutes is generous for that and short enough that
// an abandoned handshake doesn't leave a live verifier lying around.
const HANDSHAKE_MAX_AGE_SECONDS = 60 * 10;

interface WritableCookieOptions {
  readonly httpOnly: boolean;
  readonly sameSite: 'lax';
  readonly secure: boolean;
  readonly path: string;
  readonly maxAge: number;
}

/**
 * Structurally matches both `next/headers`' `cookies()` result (in a Route
 * Handler, where it is mutable) and a `NextResponse`'s `.cookies` (used by
 * middleware, which has no `next/headers` request store at all). Every
 * writer in this file takes one of these instead of calling `cookies()`
 * itself, so the same attribute logic works in both contexts.
 */
export interface CookieWriter {
  set(name: string, value: string, options: WritableCookieOptions): void;
}

function attributes(maxAge: number): WritableCookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    // Cross-site `sameSite: 'lax'` (never `'strict'`) is deliberate: the
    // callback is a top-level GET navigation initiated by Cognito, a
    // cross-site context. `Strict` would withhold the state and verifier
    // cookies on exactly that request, and every sign-in would fail with
    // nothing in the logs.
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge,
  };
}

export function setIdTokenCookie(store: CookieWriter, token: string): void {
  store.set(ID_TOKEN_COOKIE_NAME, token, attributes(ID_TOKEN_MAX_AGE_SECONDS));
}

export function setRefreshTokenCookie(store: CookieWriter, token: string): void {
  store.set(REFRESH_TOKEN_COOKIE_NAME, token, attributes(REFRESH_TOKEN_MAX_AGE_SECONDS));
}

export function setOAuthStateCookie(store: CookieWriter, state: string): void {
  store.set(OAUTH_STATE_COOKIE_NAME, state, attributes(HANDSHAKE_MAX_AGE_SECONDS));
}

export function setOAuthVerifierCookie(store: CookieWriter, verifier: string): void {
  store.set(OAUTH_VERIFIER_COOKIE_NAME, verifier, attributes(HANDSHAKE_MAX_AGE_SECONDS));
}

export function setOAuthNextCookie(store: CookieWriter, next: string): void {
  store.set(OAUTH_NEXT_COOKIE_NAME, next, attributes(HANDSHAKE_MAX_AGE_SECONDS));
}

/** Clears the session: the id token, the refresh token, and any leftover handshake state/verifier. Used by sign-out and its Cognito landing page. */
export function clearSessionCookies(store: CookieWriter): void {
  for (const name of [ID_TOKEN_COOKIE_NAME, REFRESH_TOKEN_COOKIE_NAME, OAUTH_STATE_COOKIE_NAME, OAUTH_VERIFIER_COOKIE_NAME]) {
    store.set(name, '', attributes(0));
  }
}

/** Clears the spent handshake cookies after a successful callback exchange. A retained verifier is a replay surface. */
export function clearHandshakeCookies(store: CookieWriter): void {
  for (const name of [OAUTH_STATE_COOKIE_NAME, OAUTH_VERIFIER_COOKIE_NAME, OAUTH_NEXT_COOKIE_NAME]) {
    store.set(name, '', attributes(0));
  }
}
