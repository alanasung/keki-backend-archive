import { describe, expect, it, vi } from 'vitest';
import { findProfileByCognitoSub } from './profile';

// vi.mock factories are hoisted above all other top-level code, so the mock
// state must be created via vi.hoisted() rather than plain top-level consts —
// otherwise the factory runs (triggered by the `./profile` import below,
// which imports `@keki/database`) before those consts are initialized.
const { mockRows, mockWhere, mockSelect } = vi.hoisted(() => {
  const mockRows = vi.fn<() => unknown[]>();
  const mockLimit = vi.fn(() => Promise.resolve(mockRows()));
  const mockWhere = vi.fn(() => ({ limit: mockLimit }));
  const mockFrom = vi.fn(() => ({ where: mockWhere }));
  const mockSelect = vi.fn(() => ({ from: mockFrom }));
  return { mockRows, mockLimit, mockWhere, mockFrom, mockSelect };
});

vi.mock('@keki/database', () => ({
  db: { select: mockSelect },
  customers: {
    id: 'customers.id',
    householdId: 'customers.household_id',
    email: 'customers.email',
    firstName: 'customers.first_name',
    lastName: 'customers.last_name',
    role: 'customers.role',
    cognitoSub: 'customers.cognito_sub',
  },
}));

// profile.ts only needs `eq` to build a where-condition object; the real
// implementation expects genuine drizzle Column objects, which the stubbed
// `customers` above does not provide, so it is stubbed out too.
vi.mock('drizzle-orm', () => ({ eq: vi.fn((column: unknown, value: unknown) => ({ column, value })) }));

const CUSTOMER_ROW = {
  id: '11111111-1111-4111-8111-111111111111',
  householdId: '22222222-2222-4222-8222-222222222222',
  email: 'person@example.com',
  firstName: 'Ada',
  lastName: 'Lovelace',
  role: 'CUSTOMER' as const,
};

describe('findProfileByCognitoSub', () => {
  it('maps a found row to a CustomerProfile with branded ids', async () => {
    mockRows.mockReturnValue([CUSTOMER_ROW]);

    const profile = await findProfileByCognitoSub('cognito-sub-1');

    expect(profile).not.toBeNull();
    expect(profile?.customerId).toBe(CUSTOMER_ROW.id);
    expect(profile?.householdId).toBe(CUSTOMER_ROW.householdId);
    expect(profile?.email).toBe(CUSTOMER_ROW.email);
    expect(profile?.firstName).toBe(CUSTOMER_ROW.firstName);
    expect(profile?.lastName).toBe(CUSTOMER_ROW.lastName);
    expect(profile?.role).toBe('CUSTOMER');
    expect(mockWhere).toHaveBeenCalledWith({ column: 'customers.cognito_sub', value: 'cognito-sub-1' });
  });

  it('returns null when no row matches', async () => {
    mockRows.mockReturnValue([]);

    const profile = await findProfileByCognitoSub('cognito-sub-missing');

    expect(profile).toBeNull();
  });
});
