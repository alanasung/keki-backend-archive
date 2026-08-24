import type { SessionResult } from '@keki/auth';
import type { Customer } from '@keki/contracts';
import { createCustomerId, createHouseholdId } from '@keki/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCookiesGet, mockGetSessionResult, mockProvisionCustomerProfile, mockRedirect } = vi.hoisted(() => ({
  mockCookiesGet: vi.fn(),
  mockGetSessionResult: vi.fn(),
  mockProvisionCustomerProfile: vi.fn(),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock('../require-session', () => ({ getSessionResult: mockGetSessionResult }));
vi.mock('@keki/customer-core', () => ({ provisionCustomerProfile: mockProvisionCustomerProfile }));
vi.mock('next/navigation', () => ({ redirect: mockRedirect }));
vi.mock('next/headers', () => ({ cookies: vi.fn(() => Promise.resolve({ get: mockCookiesGet })) }));

import { completeProfileAction } from './complete-profile-action';

const FIXTURE_CUSTOMER_ID = createCustomerId('11111111-1111-4111-8111-111111111111');
const FIXTURE_HOUSEHOLD_ID = createHouseholdId('22222222-2222-4222-8222-222222222222');

function fixtureCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: FIXTURE_CUSTOMER_ID,
    householdId: FIXTURE_HOUSEHOLD_ID,
    cognitoSub: 'cognito-sub-1',
    email: 'ada@example.com',
    firstName: 'Ada',
    lastName: 'Lovelace',
    phone: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

function unprovisioned(overrides: Partial<Extract<SessionResult, { kind: 'unprovisioned' }>> = {}): void {
  const result: SessionResult = {
    kind: 'unprovisioned',
    cognitoSub: 'cognito-sub-1',
    email: 'ada@example.com',
    givenName: 'Ada',
    familyName: 'Lovelace',
    ...overrides,
  };
  mockGetSessionResult.mockResolvedValue(result);
}

function anonymous(): void {
  mockGetSessionResult.mockResolvedValue({ kind: 'anonymous' });
}

/** The driver-level error node-postgres and neon-http both produce. */
function rawSqlStateError(code: string): Error {
  return Object.assign(new Error('duplicate key value violates unique constraint'), { code });
}

/** What Drizzle actually surfaces: the driver error wrapped one level down. */
function drizzleWrapped(cause: Error): Error {
  return Object.assign(new Error('Failed query: insert into "customers" ...'), {
    name: 'DrizzleQueryError',
    cause,
  });
}

describe('completeProfileAction', () => {
  beforeEach(() => {
    mockCookiesGet.mockReset();
    mockGetSessionResult.mockReset();
    mockProvisionCustomerProfile.mockReset();
    mockProvisionCustomerProfile.mockResolvedValue(fixtureCustomer());
    mockRedirect.mockClear();
  });

  // Test 9 — SC-09
  it('creates the profile with the token cognitoSub and email, not the payload', async () => {
    unprovisioned({ cognitoSub: 'cognito-sub-real', email: 'ada@example.com' });
    mockCookiesGet.mockReturnValue(undefined);

    await expect(completeProfileAction({ firstName: 'Ada', lastName: 'Lovelace' })).rejects.toThrow('REDIRECT:');

    expect(mockProvisionCustomerProfile).toHaveBeenCalledWith({
      cognitoSub: 'cognito-sub-real',
      email: 'ada@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
  });

  // Test 10
  it('rejects a payload-supplied email rather than letting it reach the command', async () => {
    unprovisioned({ email: 'ada@example.com' });

    const result = await completeProfileAction({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'attacker@example.com',
    });

    expect(result.ok).toBe(false);
    expect(mockProvisionCustomerProfile).not.toHaveBeenCalled();
  });

  // Test 11
  it('rejects a payload-supplied cognitoSub rather than letting it reach the command', async () => {
    unprovisioned({ cognitoSub: 'cognito-sub-real' });

    const result = await completeProfileAction({
      firstName: 'Ada',
      lastName: 'Lovelace',
      cognitoSub: 'attacker-sub',
    });

    expect(result.ok).toBe(false);
    expect(mockProvisionCustomerProfile).not.toHaveBeenCalled();
  });

  // Test 12
  it('rejects an anonymous caller and never calls the command', async () => {
    anonymous();

    const result = await completeProfileAction({ firstName: 'Ada', lastName: 'Lovelace' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNAUTHENTICATED');
    }
    expect(mockProvisionCustomerProfile).not.toHaveBeenCalled();
  });

  // Test 13 — SC-10
  it('does not create a second household for an already-provisioned caller', async () => {
    unprovisioned();
    const existing = fixtureCustomer({ id: FIXTURE_CUSTOMER_ID, householdId: FIXTURE_HOUSEHOLD_ID });
    mockProvisionCustomerProfile.mockResolvedValue(existing);
    mockCookiesGet.mockReturnValue(undefined);

    await expect(completeProfileAction({ firstName: 'Ada', lastName: 'Lovelace' })).rejects.toThrow('REDIRECT:');

    // provisionCustomerProfile is idempotent on cognitoSub (customer-core's
    // own coverage); this action's obligation is to call it exactly once per
    // submission and rely on its return, not to layer a second guard on top.
    expect(mockProvisionCustomerProfile).toHaveBeenCalledTimes(1);
  });

  // Test 14
  it('surfaces a duplicate cognito_sub insert as CONFLICT rather than crashing', async () => {
    unprovisioned();
    mockProvisionCustomerProfile.mockRejectedValue(drizzleWrapped(rawSqlStateError('23505')));

    const result = await completeProfileAction({ firstName: 'Ada', lastName: 'Lovelace' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('CONFLICT');
      expect(result.error.message.length).toBeGreaterThan(0);
    }
  });

  // Test 15
  it('refuses blank names before calling the command', async () => {
    unprovisioned();

    const result = await completeProfileAction({ firstName: '  ', lastName: 'Lovelace' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
    }
    expect(mockProvisionCustomerProfile).not.toHaveBeenCalled();
  });

  // Test 16 — SC-09
  it('redirects to the stored next path on success', async () => {
    unprovisioned();
    mockCookiesGet.mockReturnValue({ value: '/account' });

    await expect(completeProfileAction({ firstName: 'Ada', lastName: 'Lovelace' })).rejects.toThrow(
      'REDIRECT:/account',
    );
  });

  // Test 17
  it('re-sanitizes the stored next path, refusing to redirect off-site', async () => {
    unprovisioned();
    mockCookiesGet.mockReturnValue({ value: 'https://evil.example/steal' });

    await expect(completeProfileAction({ firstName: 'Ada', lastName: 'Lovelace' })).rejects.toThrow(/^REDIRECT:\//);
  });

  // Test 18
  it('defaults to /book when no next path is stored', async () => {
    unprovisioned();
    mockCookiesGet.mockReturnValue(undefined);

    await expect(completeProfileAction({ firstName: 'Ada', lastName: 'Lovelace' })).rejects.toThrow(
      'REDIRECT:/book',
    );
  });
});
