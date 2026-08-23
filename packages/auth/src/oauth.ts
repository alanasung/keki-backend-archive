import { createHash, randomBytes } from 'node:crypto';
import type { AuthorizationRequest, CognitoTokenResponse, PkcePair } from '@keki/contracts';
import { cognitoTokenResponseSchema } from '@keki/contracts';
import { cognitoEnv } from './env';
import { cognitoOAuthEnv } from './oauth-env';
import { OAuthExchangeError, OAuthRefreshError } from './errors';

const TOKEN_ENDPOINT_PATH = '/oauth2/token';

/**
 * 32 random bytes, base64url, no padding. Node's `'base64url'` encoding is
 * already RFC 4648 §5 (`+`→`-`, `/`→`_`, `=` stripped), so no manual
 * translation is needed.
 */
function randomBase64Url(): string {
  return randomBytes(32).toString('base64url');
}

/** PKCE verifier and its S256 challenge — RFC 7636. */
export function createPkcePair(): PkcePair {
  const verifier = randomBase64Url();
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * Builds the Cognito hosted-UI authorization URL for the code flow with
 * PKCE. The redirect URI is never a parameter — it always comes from
 * `cognitoOAuthEnv`, because a caller-supplied redirect would be an open
 * redirect and Cognito's exact-match client registration is the only thing
 * that would catch it.
 */
export function buildAuthorizationUrl(input?: { now?: () => number }): AuthorizationRequest {
  // Accepted for interface symmetry with the rest of the handshake (e.g.
  // `shouldRefresh`'s injectable clock); the authorization URL carries no
  // timestamp of its own, so `now` is not consulted.
  void input?.now;

  const { verifier, challenge } = createPkcePair();
  const state = randomBase64Url();

  const url = new URL('/oauth2/authorize', cognitoOAuthEnv.hostedUiUrl);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: cognitoEnv.clientId,
    redirect_uri: cognitoOAuthEnv.redirectUri,
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();

  return { url: url.toString(), state, verifier };
}

/**
 * Shared body of `exchangeCodeForTokens` and `refreshSession`: POST to
 * Cognito's token endpoint, reject non-2xx responses, and validate the body
 * against WS-01's schema. `createError` supplies the distinct typed error
 * each caller needs, so a state mismatch, an exchange failure, and a refresh
 * failure never collapse into one indistinguishable error type.
 */
async function postToTokenEndpoint(
  body: URLSearchParams,
  fetchImpl: typeof fetch,
  createError: (status: number, message?: string) => Error,
): Promise<CognitoTokenResponse> {
  const response = await fetchImpl(`${cognitoOAuthEnv.hostedUiUrl}${TOKEN_ENDPOINT_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    // Never include the response body: a token endpoint's error body can
    // echo the authorization code back.
    throw createError(response.status);
  }

  const json: unknown = await response.json();
  const parsed = cognitoTokenResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw createError(response.status, 'Cognito token response failed schema validation.');
  }

  return parsed.data;
}

/** Exchanges an authorization code for tokens. SC-03 (partial — WS-04 sets the cookie). */
export async function exchangeCodeForTokens(input: {
  code: string;
  verifier: string;
  fetchImpl?: typeof fetch;
}): Promise<CognitoTokenResponse> {
  const { code, verifier, fetchImpl = fetch } = input;

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: cognitoEnv.clientId,
    code,
    redirect_uri: cognitoOAuthEnv.redirectUri,
    code_verifier: verifier,
  });

  return postToTokenEndpoint(body, fetchImpl, (status, message) => new OAuthExchangeError(status, message));
}

/**
 * Refreshes a session from a refresh token. SC-06 (partial). Cognito omits
 * `refresh_token` on this exchange — the caller keeps the one it already
 * has, and WS-01's schema makes the field optional so this does not fail
 * parsing.
 */
export async function refreshSession(input: {
  refreshToken: string;
  fetchImpl?: typeof fetch;
}): Promise<CognitoTokenResponse> {
  const { refreshToken, fetchImpl = fetch } = input;

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: cognitoEnv.clientId,
    refresh_token: refreshToken,
  });

  return postToTokenEndpoint(body, fetchImpl, (status, message) => new OAuthRefreshError(status, message));
}

/**
 * Builds the Cognito logout URL. SC-07 (partial). Clearing the local cookie
 * alone leaves the Cognito session alive, so the next sign-in would silently
 * reuse it and the user would appear never to have signed out.
 */
export function buildSignOutUrl(): string {
  const url = new URL('/logout', cognitoOAuthEnv.hostedUiUrl);
  url.search = new URLSearchParams({
    client_id: cognitoEnv.clientId,
    logout_uri: cognitoOAuthEnv.signOutUri,
  }).toString();

  return url.toString();
}

/**
 * True when `expiresAt` is within `skewSeconds` of `now` (default 120s), or
 * already past. Refreshing exactly at expiry races the clock: a token that
 * expires mid-request fails the request that triggered the refresh.
 */
export function shouldRefresh(expiresAt: Date, now: Date, skewSeconds = 120): boolean {
  return expiresAt.getTime() - now.getTime() <= skewSeconds * 1000;
}
