import { createCustomerId, ROLES, type Role } from '@keki/contracts';
import { describe, expect, it, vi } from 'vitest';
import { authorize } from './authorize';
import type { Session, SessionResult } from './session';

// authorize() must perform no I/O (case 12). Proven by making any access to
// @keki/database blow up: if authorize.ts (or anything it imports) ever
// touched the database, this whole test file would fail to load.
vi.mock('@keki/database', () => {
  throw new Error('authorize() must not import @keki/database');
});

const FIXTURE_CUSTOMER_ID = createCustomerId('11111111-1111-4111-8111-111111111111');

function authenticated(role: Role): SessionResult {
  const session: Session = {
    cognitoSub: 'cognito-sub-1',
    profile: {
      customerId: FIXTURE_CUSTOMER_ID,
      householdId: null,
      email: 'person@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
      role,
    },
  };
  return { kind: 'authenticated', session };
}

const anonymous: SessionResult = { kind: 'anonymous' };
const unprovisioned: SessionResult = {
  kind: 'unprovisioned',
  cognitoSub: 'cognito-sub-2',
  email: undefined,
  givenName: undefined,
  familyName: undefined,
};

describe('authorize', () => {
  // Case 8
  it('allows a session whose role exactly matches the required role', () => {
    for (const role of ROLES) {
      const outcome = authorize({ result: authenticated(role), requiredRole: role });
      expect(outcome.allowed).toBe(true);
    }
  });

  // Case 9
  it('allows a session with a higher role than required', () => {
    const outcome = authorize({ result: authenticated('ADMIN'), requiredRole: 'FRONT_OF_HOUSE' });
    expect(outcome.allowed).toBe(true);
  });

  // Case 10
  it('denies a session with a lower role than required, with reason insufficient_role', () => {
    const outcome = authorize({ result: authenticated('CUSTOMER'), requiredRole: 'MANAGER' });
    expect(outcome).toEqual({ allowed: false, reason: 'insufficient_role' });
  });

  // Case 11
  it('distinguishes anonymous from unprovisioned', () => {
    const anonymousOutcome = authorize({ result: anonymous, requiredRole: 'CUSTOMER' });
    const unprovisionedOutcome = authorize({ result: unprovisioned, requiredRole: 'CUSTOMER' });

    expect(anonymousOutcome).toEqual({ allowed: false, reason: 'anonymous' });
    expect(unprovisionedOutcome).toEqual({ allowed: false, reason: 'unprovisioned' });
    expect(anonymousOutcome).not.toEqual(unprovisionedOutcome);
  });

  // Case 12
  it('performs no I/O, returning normally even with the database module stubbed to throw', () => {
    const outcome = authorize({ result: authenticated('ADMIN'), requiredRole: 'ADMIN' });
    expect(outcome.allowed).toBe(true);
  });
});
