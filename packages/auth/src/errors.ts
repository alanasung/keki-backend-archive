export class AuthConfigError extends Error {
  readonly kind = 'AuthConfigError' as const;

  constructor(message: string) {
    super(message);
    this.name = 'AuthConfigError';
  }
}

export class InvalidTokenError extends Error {
  readonly kind = 'InvalidTokenError' as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'InvalidTokenError';
  }
}

export class ProfileNotFoundError extends Error {
  readonly kind = 'ProfileNotFoundError' as const;

  constructor(cognitoSub: string) {
    super(`No customer profile found for Cognito subject "${cognitoSub}".`);
    this.name = 'ProfileNotFoundError';
  }
}

/**
 * The `state` returned from Cognito's redirect did not match the one issued
 * with the authorization URL. Kept distinct from `OAuthExchangeError`
 * because this is a possible attack (CSRF / handshake injection), not a
 * misconfiguration, and the two must be distinguishable in logs.
 */
export class OAuthStateMismatchError extends Error {
  readonly kind = 'OAuthStateMismatchError' as const;

  constructor(message = 'The OAuth state parameter did not match the value issued for this handshake.') {
    super(message);
    this.name = 'OAuthStateMismatchError';
  }
}

/**
 * The authorization-code or refresh-token exchange with Cognito's token
 * endpoint returned a non-2xx response. Carries the HTTP status but never
 * the response body — a token endpoint's error body can echo the
 * authorization code back.
 */
export class OAuthExchangeError extends Error {
  readonly kind = 'OAuthExchangeError' as const;
  readonly status: number;

  constructor(status: number, message?: string) {
    super(message ?? `Cognito token exchange failed with status ${status}.`);
    this.name = 'OAuthExchangeError';
    this.status = status;
  }
}

/**
 * A refresh-token exchange with Cognito's token endpoint failed. Distinct
 * from `OAuthExchangeError` so callers can tell "sign back in" (a refresh
 * failure means the session is over) apart from "the initial exchange was
 * misconfigured" without inspecting the message.
 */
export class OAuthRefreshError extends Error {
  readonly kind = 'OAuthRefreshError' as const;
  readonly status: number;

  constructor(status: number, message?: string) {
    super(message ?? `Cognito token refresh failed with status ${status}.`);
    this.name = 'OAuthRefreshError';
    this.status = status;
  }
}
