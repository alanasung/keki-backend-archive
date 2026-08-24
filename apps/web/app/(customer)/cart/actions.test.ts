import type { Session, SessionResult } from '@keki/auth';
import {
  createCatalogItemId,
  createChildId,
  createCustomerId,
  createHouseholdId,
  createOccurrenceId,
  type Cart,
  type Child,
  type Customer,
  type HouseholdId,
} from '@keki/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const FIXTURE_HOUSEHOLD_ID = createHouseholdId('11111111-1111-4111-8111-111111111111');
const FIXTURE_CUSTOMER_ID = createCustomerId('22222222-2222-4222-8222-222222222222');
const FIXTURE_CHILD_ID = createChildId('33333333-3333-4333-8333-333333333333');
const FOREIGN_CHILD_ID = createChildId('44444444-4444-4444-8444-444444444444');
const FIXTURE_CATALOG_ITEM_ID = createCatalogItemId('55555555-5555-4555-8555-555555555555');
const FIXTURE_OCCURRENCE_ID = createOccurrenceId('66666666-6666-4666-8666-666666666666');

interface CartStore {
  current: Cart;
}

const { cartStore, mockAuthorize, mockGetSessionResult, mockListHouseholdMembers, mockRevalidatePath } = vi.hoisted(
  () => {
    const store: CartStore = { current: { lines: [] } };
    return {
      cartStore: store,
      mockAuthorize: vi.fn(),
      mockGetSessionResult: vi.fn(),
      mockListHouseholdMembers: vi.fn(),
      mockRevalidatePath: vi.fn(),
    };
  },
);

vi.mock('@keki/auth', () => ({ authorize: mockAuthorize }));
vi.mock('../../auth/require-session', () => ({ getSessionResult: mockGetSessionResult }));
// Partial mock: errors.ts (WS-07) instanceof-checks real customer-core
// error classes on every thrown error, including ParticipantNotInHouseholdError
// here, so those classes must stay real even though listHouseholdMembers is
// replaced with a controllable fixture.
vi.mock('@keki/customer-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@keki/customer-core')>();
  return { ...actual, listHouseholdMembers: mockListHouseholdMembers };
});
vi.mock('next/cache', () => ({ revalidatePath: mockRevalidatePath }));

vi.mock('./cart-cookie', () => ({
  readCart: vi.fn(() => Promise.resolve(cartStore.current)),
  writeCart: vi.fn((cart: Cart) => {
    cartStore.current = cart;
    return Promise.resolve();
  }),
  clearCart: vi.fn(() => {
    cartStore.current = { lines: [] };
    return Promise.resolve();
  }),
}));

import { readCart, writeCart } from './cart-cookie';
import { addCafeItemAction, addClassSeatsAction, removeLineAction, updateCafeQuantityAction } from './actions';

function fixtureCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: FIXTURE_CUSTOMER_ID,
    householdId: FIXTURE_HOUSEHOLD_ID,
    cognitoSub: 'cognito-sub-1',
    email: 'person@example.com',
    firstName: 'Ada',
    lastName: 'Lovelace',
    phone: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

function fixtureChild(overrides: Partial<Child> = {}): Child {
  return {
    id: FIXTURE_CHILD_ID,
    householdId: FIXTURE_HOUSEHOLD_ID,
    firstName: 'Grace',
    lastName: 'Lovelace',
    dateOfBirth: new Date('2018-01-01'),
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
      email: 'person@example.com',
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

describe('cart actions', () => {
  beforeEach(() => {
    cartStore.current = { lines: [] };
    mockAuthorize.mockReset();
    mockGetSessionResult.mockReset();
    mockListHouseholdMembers.mockReset();
    mockListHouseholdMembers.mockResolvedValue({
      customers: [fixtureCustomer()],
      children: [fixtureChild()],
    });
    mockRevalidatePath.mockReset();
    vi.mocked(readCart).mockClear();
    vi.mocked(writeCart).mockClear();
  });

  // Test 8
  it('addCafeItemAction appends a new line', async () => {
    authenticate();

    const result = await addCafeItemAction({ catalogItemId: FIXTURE_CATALOG_ITEM_ID, quantity: 1 });

    expect(result.ok).toBe(true);
    expect(cartStore.current.lines).toEqual([
      { kind: 'CATALOG_ITEM', catalogItemId: FIXTURE_CATALOG_ITEM_ID, quantity: 1 },
    ]);
  });

  // Test 9
  it('adding an existing cafe item merges quantity into one line', async () => {
    authenticate();

    await addCafeItemAction({ catalogItemId: FIXTURE_CATALOG_ITEM_ID, quantity: 1 });
    await addCafeItemAction({ catalogItemId: FIXTURE_CATALOG_ITEM_ID, quantity: 1 });

    expect(cartStore.current.lines).toHaveLength(1);
    expect(cartStore.current.lines[0]).toEqual({
      kind: 'CATALOG_ITEM',
      catalogItemId: FIXTURE_CATALOG_ITEM_ID,
      quantity: 2,
    });
  });

  // Test 10
  it('addClassSeatsAction replaces the participant set rather than merging', async () => {
    authenticate();

    await addClassSeatsAction({
      occurrenceId: FIXTURE_OCCURRENCE_ID,
      participants: [
        { kind: 'CUSTOMER', customerId: FIXTURE_CUSTOMER_ID },
        { kind: 'CHILD', childId: FIXTURE_CHILD_ID },
      ],
    });
    await addClassSeatsAction({
      occurrenceId: FIXTURE_OCCURRENCE_ID,
      participants: [{ kind: 'CHILD', childId: FIXTURE_CHILD_ID }],
    });

    expect(cartStore.current.lines).toHaveLength(1);
    const line = cartStore.current.lines[0];
    expect(line?.kind).toBe('OCCURRENCE');
    if (line?.kind === 'OCCURRENCE') {
      expect(line.participants).toEqual([{ kind: 'CHILD', childId: FIXTURE_CHILD_ID }]);
    }
  });

  // Test 11
  it('updateCafeQuantityAction with 0 removes the line', async () => {
    authenticate();
    cartStore.current = { lines: [{ kind: 'CATALOG_ITEM', catalogItemId: FIXTURE_CATALOG_ITEM_ID, quantity: 3 }] };

    const result = await updateCafeQuantityAction({ catalogItemId: FIXTURE_CATALOG_ITEM_ID, quantity: 0 });

    expect(result.ok).toBe(true);
    expect(cartStore.current.lines).toEqual([]);
  });

  it('removeLineAction removes the matching line', async () => {
    authenticate();
    cartStore.current = { lines: [{ kind: 'CATALOG_ITEM', catalogItemId: FIXTURE_CATALOG_ITEM_ID, quantity: 3 }] };

    const result = await removeLineAction({ kind: 'CATALOG_ITEM', catalogItemId: FIXTURE_CATALOG_ITEM_ID });

    expect(result.ok).toBe(true);
    expect(cartStore.current.lines).toEqual([]);
  });

  // Test 12
  it('rejects an anonymous caller with UNAUTHENTICATED and never touches the cookie', async () => {
    mockGetSessionResult.mockResolvedValue(anonymousResult);
    mockAuthorize.mockReturnValue({ allowed: false, reason: 'anonymous' });

    const result = await addCafeItemAction({ catalogItemId: FIXTURE_CATALOG_ITEM_ID, quantity: 1 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNAUTHENTICATED');
    }
    expect(readCart).not.toHaveBeenCalled();
    expect(writeCart).not.toHaveBeenCalled();
  });

  // Test 13
  it('rejects a foreign child with VALIDATION and leaves the cookie unchanged', async () => {
    authenticate();
    const before: Cart = { lines: [] };
    cartStore.current = before;

    const result = await addClassSeatsAction({
      occurrenceId: FIXTURE_OCCURRENCE_ID,
      participants: [{ kind: 'CHILD', childId: FOREIGN_CHILD_ID }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
    }
    expect(cartStore.current).toEqual(before);
    expect(writeCart).not.toHaveBeenCalled();
  });

  // Test 14
  it('rejects a duplicate participant in one submission with VALIDATION', async () => {
    authenticate();

    const result = await addClassSeatsAction({
      occurrenceId: FIXTURE_OCCURRENCE_ID,
      participants: [
        { kind: 'CHILD', childId: FIXTURE_CHILD_ID },
        { kind: 'CHILD', childId: FIXTURE_CHILD_ID },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
    }
    expect(writeCart).not.toHaveBeenCalled();
  });

  // Test 15
  it('rejects an empty participant selection with VALIDATION', async () => {
    authenticate();

    const result = await addClassSeatsAction({ occurrenceId: FIXTURE_OCCURRENCE_ID, participants: [] });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
    }
    expect(writeCart).not.toHaveBeenCalled();
  });
});
