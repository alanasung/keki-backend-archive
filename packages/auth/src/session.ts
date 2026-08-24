import type { CustomerId, HouseholdId, Role } from '@keki/contracts';
import { InvalidTokenError } from './errors';
import { findProfileByCognitoSub } from './profile';
import { verifyToken } from './verify-token';

export interface CustomerProfile {
  readonly customerId: CustomerId;
  readonly householdId: HouseholdId | null;
  readonly email: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly role: Role;
}

export interface Session {
  readonly cognitoSub: string;
  readonly profile: CustomerProfile;
}

export type SessionResult =
  | { readonly kind: 'authenticated'; readonly session: Session }
  | { readonly kind: 'anonymous' }
  | {
      readonly kind: 'unprovisioned';
      readonly cognitoSub: string;
      readonly email: string | undefined;
      readonly givenName: string | undefined;
      readonly familyName: string | undefined;
    };

/**
 * Verifies a token and loads its profile. Pure of any framework: it takes the
 * token as an argument and knows nothing about cookies, `next/headers`, or
 * request caching. WS-09's `getSessionResult()` is a thin Next-specific
 * wrapper that reads the cookie and wraps this in `cache()`.
 */
export async function resolveSession(jwt: string | null): Promise<SessionResult> {
  if (jwt === null) {
    return { kind: 'anonymous' };
  }

  let verified;
  try {
    verified = await verifyToken(jwt);
  } catch (error) {
    // An expired, malformed, or otherwise invalid token is an ordinary
    // condition (the cookie outlived the session), not a server error.
    // Only InvalidTokenError is swallowed here; a misconfiguration
    // (AuthConfigError) must still surface as a genuine failure.
    if (error instanceof InvalidTokenError) {
      return { kind: 'anonymous' };
    }
    throw error;
  }

  const profile = await findProfileByCognitoSub(verified.sub);

  if (profile === null) {
    return {
      kind: 'unprovisioned',
      cognitoSub: verified.sub,
      email: verified.email,
      givenName: verified.givenName,
      familyName: verified.familyName,
    };
  }

  return {
    kind: 'authenticated',
    session: { cognitoSub: verified.sub, profile },
  };
}
