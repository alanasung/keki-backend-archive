import type { CognitoTokenResponse } from '@keki/contracts';
import { cognitoTokenResponseSchema } from '@keki/contracts';
import { cognitoEnv } from './env';
import { cognitoOAuthEnv } from './oauth-env';
import { OAuthExchangeError, OAuthRefreshError } from './errors';

const TOKEN_ENDPOINT_PATH = '/oauth2/token';

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
