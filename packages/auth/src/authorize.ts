import { hasAtLeastRole, type Role } from '@keki/contracts';
import type { Session, SessionResult } from './session';

export interface AuthorizeInput {
  readonly result: SessionResult;
  readonly requiredRole: Role;
}

export type AuthorizationOutcome =
  | { readonly allowed: true; readonly session: Session }
  | {
      readonly allowed: false;
      readonly reason: 'anonymous' | 'unprovisioned' | 'insufficient_role';
    };

/**
 * The single authorization predicate WS-09 calls on every protected route.
 * Pure: no I/O, delegating role ordering to `hasAtLeastRole` from contracts
 * so this is the only place a `SessionResult` becomes an allow/deny decision.
 */
export function authorize(input: AuthorizeInput): AuthorizationOutcome {
  const { result, requiredRole } = input;

  switch (result.kind) {
    case 'anonymous':
      return { allowed: false, reason: 'anonymous' };
    case 'unprovisioned':
      return { allowed: false, reason: 'unprovisioned' };
    case 'authenticated':
      if (!hasAtLeastRole(result.session.profile.role, requiredRole)) {
        return { allowed: false, reason: 'insufficient_role' };
      }
      return { allowed: true, session: result.session };
  }
}
