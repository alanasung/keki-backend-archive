import type { CustomerId, HouseholdId, Role } from '@keki/contracts';
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
  | { readonly kind: 'unprovisioned'; readonly cognitoSub: string };

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

  const verified = await verifyToken(jwt);
  const profile = await findProfileByCognitoSub(verified.sub);

  if (profile === null) {
    return { kind: 'unprovisioned', cognitoSub: verified.sub };
  }

  return {
    kind: 'authenticated',
    session: { cognitoSub: verified.sub, profile },
  };
}
