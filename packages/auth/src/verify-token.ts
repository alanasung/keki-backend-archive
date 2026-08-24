import { JwtVerifier } from 'aws-jwt-verify';
import { validateCognitoJwtFields } from 'aws-jwt-verify/cognito-verifier';
import { cognitoEnv } from './env';
import { InvalidTokenError } from './errors';

export interface VerifiedToken {
  readonly sub: string;
  readonly email: string | undefined;
  readonly givenName: string | undefined;
  readonly familyName: string | undefined;
  readonly tokenUse: 'id' | 'access';
  readonly expiresAt: Date;
}

/**
 * Constructed once at module scope. `aws-jwt-verify` caches the fetched JWKS
 * on this instance; constructing a verifier per call would defeat that cache
 * and add a network round trip to every authenticated request.
 *
 * We use the generic `JwtVerifier` rather than `CognitoJwtVerifier` because
 * the latter always derives its issuer/JWKS URI from `userPoolId` via regex,
 * ignoring any override — which would silently defeat the
 * `COGNITO_ISSUER`/`COGNITO_JWKS_URI` test affordance `env.ts` provides.
 * Using the generic verifier keeps exactly one verification path for both
 * production and test, differing only in which issuer/JWKS URI `env.ts`
 * resolves. Audience is intentionally not checked here — Cognito access
 * tokens carry no `aud` claim — and is instead checked below via
 * `validateCognitoJwtFields`, which knows to check `aud` for ID tokens and
 * `client_id` for access tokens.
 */
export const verifier = JwtVerifier.create({
  issuer: cognitoEnv.issuer,
  jwksUri: cognitoEnv.jwksUri,
  audience: null,
});

/**
 * Verifies signature, issuer, audience (via client ID), token use, and
 * expiry against the JWKS. Never returns null for a malformed token — always
 * throws `InvalidTokenError` — because callers reliably forget to check a
 * nullable result.
 *
 * Does not read the `cognito:groups` claim: Cognito is not the role
 * authority, Postgres is (see `profile.ts`).
 */
export async function verifyToken(jwt: string): Promise<VerifiedToken> {
  let payload;
  try {
    payload = await verifier.verify(jwt);
    validateCognitoJwtFields(payload, { tokenUse: null, clientId: cognitoEnv.clientId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new InvalidTokenError(`Token verification failed: ${message}`, { cause: error });
  }

  const { sub, exp, token_use: tokenUse, email, given_name: givenName, family_name: familyName } = payload;

  if (typeof sub !== 'string') {
    throw new InvalidTokenError('Token is missing a "sub" claim.');
  }
  if (typeof exp !== 'number') {
    throw new InvalidTokenError('Token is missing an "exp" claim.');
  }
  if (tokenUse !== 'id' && tokenUse !== 'access') {
    throw new InvalidTokenError(`Token has an unexpected "token_use" claim: ${JSON.stringify(tokenUse)}.`);
  }

  return {
    sub,
    email: typeof email === 'string' ? email : undefined,
    givenName: typeof givenName === 'string' ? givenName : undefined,
    familyName: typeof familyName === 'string' ? familyName : undefined,
    tokenUse,
    expiresAt: new Date(exp * 1000),
  };
}
