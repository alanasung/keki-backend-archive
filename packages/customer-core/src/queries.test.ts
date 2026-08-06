import { describe, expect, it, vi } from 'vitest';
import { createCustomerId, createHouseholdId } from '@keki/contracts';

// vi.mock factories are hoisted above all other top-level code, so mock state
// (including the fake table markers) must be created via vi.hoisted() — see
// packages/auth/src/profile.test.ts for the same pattern. Each query in this
// package touches a different table, so the builder resolves its rows by
// which table object was passed to `.from()`.
const { CHILDREN, CUSTOMERS, HOUSEHOLDS, mockRowsByTable, mockSelect } = vi.hoisted(() => {
  const CUSTOMERS = { tableName: 'customers' };
  const HOUSEHOLDS = { tableName: 'households' };
  const CHILDREN = { tableName: 'children' };

  const mockRowsByTable = new Map<unknown, unknown[]>([
    [CUSTOMERS, []],
    [HOUSEHOLDS, []],
    [CHILDREN, []],
  ]);

  function makeBuilder(table: unknown): PromiseLike<unknown[]> & Record<string, unknown> {
    const builder = {
      from: vi.fn((t: unknown) => makeBuilder(t)),
      where: vi.fn(() => builder),
      limit: vi.fn(() => Promise.resolve(mockRowsByTable.get(table) ?? [])),
      then: (
        onfulfilled?: (value: unknown[]) => unknown,
        onrejected?: (reason: unknown) => unknown,
      ) => Promise.resolve(mockRowsByTable.get(table) ?? []).then(onfulfilled, onrejected),
    };
    return builder as unknown as PromiseLike<unknown[]> & Record<string, unknown>;
  }

  const mockSelect = vi.fn(() => makeBuilder(undefined));

  return { CHILDREN, CUSTOMERS, HOUSEHOLDS, mockRowsByTable, mockSelect };
});

vi.mock('@keki/database', () => ({
  db: { select: mockSelect },
  customers: CUSTOMERS,
  households: HOUSEHOLDS,
  children: CHILDREN,
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
}));

import { getCustomerById, getHouseholdById, listHouseholdMembers } from './queries';

const CUSTOMER_ROW = {
  id: '11111111-1111-4111-8111-111111111111',
  householdId: '22222222-2222-4222-8222-222222222222',
  cognitoSub: 'cognito-sub-1',
  email: 'person@example.com',
  firstName: 'Ada',
  lastName: 'Lovelace',
  phone: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

const HOUSEHOLD_ROW = {
  id: '22222222-2222-4222-8222-222222222222',
  primaryCustomerId: CUSTOMER_ROW.id,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

const CHILD_ROW = {
  id: '33333333-3333-4333-8333-333333333333',
  householdId: HOUSEHOLD_ROW.id,
  firstName: 'Grace',
  lastName: 'Lovelace',
  dateOfBirth: '2018-05-01',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

describe('getCustomerById', () => {
  it('returns null for an unknown id', async () => {
    mockRowsByTable.set(CUSTOMERS, []);

    const result = await getCustomerById(createCustomerId(CUSTOMER_ROW.id));

    expect(result).toBeNull();
  });

  it('maps a found row to a Customer with branded ids', async () => {
    mockRowsByTable.set(CUSTOMERS, [CUSTOMER_ROW]);

    const result = await getCustomerById(createCustomerId(CUSTOMER_ROW.id));

    expect(result?.id).toBe(CUSTOMER_ROW.id);
    expect(result?.householdId).toBe(CUSTOMER_ROW.householdId);
    expect(result?.email).toBe(CUSTOMER_ROW.email);
  });
});

describe('getHouseholdById', () => {
  it('returns null for an unknown id', async () => {
    mockRowsByTable.set(HOUSEHOLDS, []);

    const result = await getHouseholdById(createHouseholdId(HOUSEHOLD_ROW.id));

    expect(result).toBeNull();
  });

  it('maps a found row to a Household', async () => {
    mockRowsByTable.set(HOUSEHOLDS, [HOUSEHOLD_ROW]);

    const result = await getHouseholdById(createHouseholdId(HOUSEHOLD_ROW.id));

    expect(result?.id).toBe(HOUSEHOLD_ROW.id);
    expect(result?.primaryCustomerId).toBe(HOUSEHOLD_ROW.primaryCustomerId);
  });
});

describe('listHouseholdMembers', () => {
  it('returns customers and children for the household', async () => {
    mockRowsByTable.set(CUSTOMERS, [CUSTOMER_ROW]);
    mockRowsByTable.set(CHILDREN, [CHILD_ROW]);

    const result = await listHouseholdMembers(createHouseholdId(HOUSEHOLD_ROW.id));

    expect(result.customers).toHaveLength(1);
    expect(result.children).toHaveLength(1);
    expect(result.children[0]?.dateOfBirth).toBeInstanceOf(Date);
  });

  it('returns empty arrays, not null, when the household has no members', async () => {
    mockRowsByTable.set(CUSTOMERS, []);
    mockRowsByTable.set(CHILDREN, []);

    const result = await listHouseholdMembers(createHouseholdId(HOUSEHOLD_ROW.id));

    expect(result.customers).toEqual([]);
    expect(result.children).toEqual([]);
  });
});
