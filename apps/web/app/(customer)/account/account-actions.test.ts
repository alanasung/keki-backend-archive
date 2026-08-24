import type { Session, SessionResult } from '@keki/auth';
import {
  createChildId,
  createCustomerId,
  createHouseholdId,
  type Child,
  type Household,
  type HouseholdId,
} from '@keki/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidDateOfBirthError } from '@keki/customer-core';

const FIXTURE_HOUSEHOLD_ID = createHouseholdId('11111111-1111-4111-8111-111111111111');
const FOREIGN_HOUSEHOLD_ID = createHouseholdId('99999999-9999-4999-8999-999999999999');
const FIXTURE_CUSTOMER_ID = createCustomerId('22222222-2222-4222-8222-222222222222');

const { mockAddChild, mockAuthorize, mockGetSessionResult, mockRevalidatePath, mockUpdateHousehold } = vi.hoisted(
  () => ({
    mockAddChild: vi.fn(),
    mockAuthorize: vi.fn(),
    mockGetSessionResult: vi.fn(),
    mockRevalidatePath: vi.fn(),
    mockUpdateHousehold: vi.fn(),
  }),
);

vi.mock('@keki/auth', () => ({ authorize: mockAuthorize }));
vi.mock('../../auth/require-session', () => ({ getSessionResult: mockGetSessionResult }));
vi.mock('@keki/customer-core', async () => {
  const actual = await vi.importActual<typeof import('@keki/customer-core')>('@keki/customer-core');
  return { ...actual, addChild: mockAddChild, updateHousehold: mockUpdateHousehold };
});
vi.mock('next/cache', () => ({ revalidatePath: mockRevalidatePath }));

import { addChildAction, updateHouseholdNameAction } from './account-actions';

function fixtureChild(overrides: Partial<Child> = {}): Child {
  return {
    id: createChildId('33333333-3333-4333-8333-333333333333'),
    householdId: FIXTURE_HOUSEHOLD_ID,
    firstName: 'Grace',
    lastName: 'Lovelace',
    dateOfBirth: new Date('2019-03-04'),
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

function fixtureHousehold(overrides: Partial<Household> = {}): Household {
  return {
    id: FIXTURE_HOUSEHOLD_ID,
    primaryCustomerId: FIXTURE_CUSTOMER_ID,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

function fixtureSession(householdId: HouseholdId | null = FIXTURE_HOUSEHOLD_ID): Session {
  return {
    cognitoSub: 'cognito-sub-1',
    profile: {
      customerId: FIXTURE_CUSTOMER_ID,
      householdId,
      email: 'ada@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
      role: 'CUSTOMER',
    },
  };
}

const anonymousResult: SessionResult = { kind: 'anonymous' };

function authenticate(householdId: HouseholdId | null = FIXTURE_HOUSEHOLD_ID): void {
  const session = fixtureSession(householdId);
  mockGetSessionResult.mockResolvedValue({ kind: 'authenticated', session });
  mockAuthorize.mockReturnValue({ allowed: true, session });
}

describe('addChildAction', () => {
  beforeEach(() => {
    mockAddChild.mockReset();
    mockAddChild.mockResolvedValue(fixtureChild());
    mockAuthorize.mockReset();
    mockGetSessionResult.mockReset();
    mockRevalidatePath.mockReset();
    mockUpdateHousehold.mockReset();
  });

  // Test 6 — SC-12
  it('passes the session household to addChild, not anything from the payload', async () => {
    authenticate(FIXTURE_HOUSEHOLD_ID);

    const result = await addChildAction({ firstName: 'Grace', lastName: 'Lovelace', dateOfBirth: '2019-03-04' });

    expect(result.ok).toBe(true);
    expect(mockAddChild).toHaveBeenCalledWith(
      expect.objectContaining({
        householdId: FIXTURE_HOUSEHOLD_ID,
        firstName: 'Grace',
        lastName: 'Lovelace',
      }),
    );
  });

  // Test 7 — SC-12: addChildSchema is .strict(), so a payload carrying an
  // unrecognized "householdId" key fails validation before the handler (and
  // therefore addChild) ever runs — the strongest form of "ignored".
  it('rejects a payload-supplied householdId rather than letting it reach the command', async () => {
    authenticate(FIXTURE_HOUSEHOLD_ID);

    const result = await addChildAction({
      firstName: 'Grace',
      lastName: 'Lovelace',
      dateOfBirth: '2019-03-04',
      householdId: FOREIGN_HOUSEHOLD_ID,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
    }
    expect(mockAddChild).not.toHaveBeenCalled();
  });

  // Test 8
  it('yields a VALIDATION error and never calls addChild when the profile has no household', async () => {
    authenticate(null);

    const result = await addChildAction({ firstName: 'Grace', lastName: 'Lovelace', dateOfBirth: '2019-03-04' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
    }
    expect(mockAddChild).not.toHaveBeenCalled();
  });

  // Test 9 — SC-13. Uses a payload date that passes addChildSchema's own
  // future-date refinement (2019, not 2099) so the mocked command is what
  // actually rejects — the schema's own refusal is covered by
  // packages/contracts/src/onboarding.test.ts, not this file.
  it('surfaces the command rejecting a future date as VALIDATION naming the constraint', async () => {
    authenticate(FIXTURE_HOUSEHOLD_ID);
    mockAddChild.mockRejectedValue(new InvalidDateOfBirthError(new Date('2099-01-01')));

    const result = await addChildAction({ firstName: 'Grace', lastName: 'Lovelace', dateOfBirth: '2019-03-04' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
      expect(result.error.message).toContain('cannot be in the future');
    }
  });

  // Test 13 — SC-15's mechanism
  it('revalidates /book so a newly added child appears in the participant picker', async () => {
    authenticate(FIXTURE_HOUSEHOLD_ID);

    await addChildAction({ firstName: 'Grace', lastName: 'Lovelace', dateOfBirth: '2019-03-04' });

    expect(mockRevalidatePath).toHaveBeenCalledWith('/book');
  });

  // Test 14
  it('revalidates /account so the household list updates', async () => {
    authenticate(FIXTURE_HOUSEHOLD_ID);

    await addChildAction({ firstName: 'Grace', lastName: 'Lovelace', dateOfBirth: '2019-03-04' });

    expect(mockRevalidatePath).toHaveBeenCalledWith('/account');
  });

  it('rejects an anonymous caller and never calls addChild', async () => {
    mockGetSessionResult.mockResolvedValue(anonymousResult);
    mockAuthorize.mockReturnValue({ allowed: false, reason: 'anonymous' });

    const result = await addChildAction({ firstName: 'Grace', lastName: 'Lovelace', dateOfBirth: '2019-03-04' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNAUTHENTICATED');
    }
    expect(mockAddChild).not.toHaveBeenCalled();
  });
});

describe('updateHouseholdNameAction', () => {
  beforeEach(() => {
    mockAddChild.mockReset();
    mockAuthorize.mockReset();
    mockGetSessionResult.mockReset();
    mockRevalidatePath.mockReset();
    mockUpdateHousehold.mockReset();
    mockUpdateHousehold.mockResolvedValue({ ...fixtureHousehold(), name: 'Lovelace Household' });
  });

  it('passes the session household to updateHousehold, not anything from the payload', async () => {
    authenticate(FIXTURE_HOUSEHOLD_ID);

    const result = await updateHouseholdNameAction({ name: 'Lovelace Household' });

    expect(result.ok).toBe(true);
    expect(mockUpdateHousehold).toHaveBeenCalledWith({
      householdId: FIXTURE_HOUSEHOLD_ID,
      name: 'Lovelace Household',
    });
  });

  it('rejects a payload-supplied householdId rather than letting it reach the command', async () => {
    authenticate(FIXTURE_HOUSEHOLD_ID);

    const result = await updateHouseholdNameAction({
      name: 'Lovelace Household',
      householdId: FOREIGN_HOUSEHOLD_ID,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
    }
    expect(mockUpdateHousehold).not.toHaveBeenCalled();
  });

  // Test 8's counterpart for the rename action
  it('yields a VALIDATION error and never calls updateHousehold when the profile has no household', async () => {
    authenticate(null);

    const result = await updateHouseholdNameAction({ name: 'Lovelace Household' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
    }
    expect(mockUpdateHousehold).not.toHaveBeenCalled();
  });

  // Test 21
  it('refuses a blank name before calling updateHousehold', async () => {
    authenticate(FIXTURE_HOUSEHOLD_ID);

    const result = await updateHouseholdNameAction({ name: '  ' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
    }
    expect(mockUpdateHousehold).not.toHaveBeenCalled();
  });

  it('revalidates /account after a successful rename', async () => {
    authenticate(FIXTURE_HOUSEHOLD_ID);

    await updateHouseholdNameAction({ name: 'Lovelace Household' });

    expect(mockRevalidatePath).toHaveBeenCalledWith('/account');
  });
});
