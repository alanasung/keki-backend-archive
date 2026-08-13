import type { Session, SessionResult } from '@keki/auth';
import {
  createCatalogItemId,
  createCustomerId,
  createHouseholdId,
  createOccurrenceId,
  createOrderId,
  type Cart,
  type Order,
} from '@keki/contracts';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const FIXTURE_HOUSEHOLD_ID = createHouseholdId('11111111-1111-4111-8111-111111111111');
const FIXTURE_CUSTOMER_ID = createCustomerId('22222222-2222-4222-8222-222222222222');
const FIXTURE_FOREIGN_CUSTOMER_ID = createCustomerId('33333333-3333-4333-8333-333333333333');
const FIXTURE_ORDER_ID = createOrderId('44444444-4444-4444-8444-444444444444');
const FIXTURE_OCCURRENCE_ID = createOccurrenceId('55555555-5555-4555-8555-555555555555');
const FIXTURE_CATALOG_ITEM_ID = createCatalogItemId('66666666-6666-4666-8666-666666666666');
const FIXTURE_CHECKOUT_URL = 'https://squareup.com/checkout/stub-session';
const FIXTURE_APP_BASE_URL = 'https://keki.example.com';

interface CartStore {
  current: Cart;
}

const {
  cartStore,
  mockAuthorize,
  mockGetSessionResult,
  mockCreateOrder,
  mockStartCheckout,
  mockGetSquareClient,
  mockGetSeatHolder,
  mockHoldReservation,
  mockClearCart,
} = vi.hoisted(() => {
  const store: CartStore = { current: { lines: [] } };
  return {
    cartStore: store,
    mockAuthorize: vi.fn(),
    mockGetSessionResult: vi.fn(),
    mockCreateOrder: vi.fn(),
    mockStartCheckout: vi.fn(),
    mockGetSquareClient: vi.fn(),
    mockGetSeatHolder: vi.fn(),
    mockHoldReservation: vi.fn(),
    mockClearCart: vi.fn(() => {
      store.current = { lines: [] };
      return Promise.resolve();
    }),
  };
});

vi.mock('@keki/auth', () => ({ authorize: mockAuthorize }));
vi.mock('../../auth/require-session', () => ({ getSessionResult: mockGetSessionResult }));

vi.mock('./cart-cookie', () => ({
  readCart: vi.fn(() => Promise.resolve(cartStore.current)),
  clearCart: mockClearCart,
}));

vi.mock('../../server-clients', () => ({
  getSquareClient: mockGetSquareClient,
  getSeatHolder: mockGetSeatHolder,
}));

// holdReservation is never imported by checkout-action.ts; mocked here only
// so test 12 has something concrete to assert was never called, proving the
// action delegates seat holding to createOrder rather than calling this
// itself. The rest of the module (CapacityExceededError included) is real,
// so `instanceof` checks against it still hold.
vi.mock('@keki/reservation-core', async () => {
  const actual = await vi.importActual<typeof import('@keki/reservation-core')>('@keki/reservation-core');
  return { ...actual, holdReservation: mockHoldReservation };
});

// ParticipantNotInHouseholdError stays real via the spread below, so
// checkout-action.ts's `instanceof ParticipantNotInHouseholdError` check
// still matches the instance this file constructs for test 14.
vi.mock('@keki/commerce-core', async () => {
  const actual = await vi.importActual<typeof import('@keki/commerce-core')>('@keki/commerce-core');
  return {
    ...actual,
    createOrder: mockCreateOrder,
    startCheckout: mockStartCheckout,
  };
});

import { ParticipantNotInHouseholdError } from '@keki/commerce-core';
import { CapacityExceededError } from '@keki/reservation-core';
import { SquareApiError } from '@keki/square-client';
import { checkoutAction } from './checkout-action';

function fixtureSession(overrides: Partial<Session['profile']> = {}): Session {
  return {
    cognitoSub: 'cognito-sub-1',
    profile: {
      customerId: FIXTURE_CUSTOMER_ID,
      householdId: FIXTURE_HOUSEHOLD_ID,
      email: 'ada@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
      role: 'CUSTOMER',
      ...overrides,
    },
  };
}

const anonymousResult: SessionResult = { kind: 'anonymous' };

function authenticate(overrides: Partial<Session['profile']> = {}): void {
  const session = fixtureSession(overrides);
  mockGetSessionResult.mockResolvedValue({ kind: 'authenticated', session });
  mockAuthorize.mockReturnValue({ allowed: true, session });
}

function fixtureOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: FIXTURE_ORDER_ID,
    householdId: FIXTURE_HOUSEHOLD_ID,
    createdByCustomerId: FIXTURE_CUSTOMER_ID,
    status: 'DRAFT',
    subtotalCents: 1500,
    currency: 'USD',
    squareOrderId: null,
    squareCheckoutUrl: null,
    providerPaymentId: null,
    expiresAt: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

const NON_EMPTY_CART: Cart = {
  lines: [{ kind: 'CATALOG_ITEM', catalogItemId: FIXTURE_CATALOG_ITEM_ID, quantity: 1 }],
};

const ORIGINAL_APP_BASE_URL = process.env['APP_BASE_URL'];

beforeEach(() => {
  cartStore.current = NON_EMPTY_CART;
  mockAuthorize.mockReset();
  mockGetSessionResult.mockReset();
  mockCreateOrder.mockReset().mockResolvedValue({ order: fixtureOrder(), lineItems: [] });
  mockStartCheckout.mockReset().mockResolvedValue({ checkoutUrl: FIXTURE_CHECKOUT_URL, squareOrderId: 'sq-order-1' });
  mockGetSquareClient.mockReset().mockReturnValue({ kind: 'square-client-instance' });
  mockGetSeatHolder.mockReset().mockReturnValue({ kind: 'seat-holder-instance' });
  mockHoldReservation.mockReset();
  mockClearCart.mockClear();
  process.env['APP_BASE_URL'] = FIXTURE_APP_BASE_URL;
});

afterAll(() => {
  if (ORIGINAL_APP_BASE_URL === undefined) {
    delete process.env['APP_BASE_URL'];
  } else {
    process.env['APP_BASE_URL'] = ORIGINAL_APP_BASE_URL;
  }
});

describe('checkoutAction', () => {
  // Test 7
  it('requires authentication and creates no order', async () => {
    mockGetSessionResult.mockResolvedValue(anonymousResult);
    mockAuthorize.mockReturnValue({ allowed: false, reason: 'anonymous' });

    const result = await checkoutAction({});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNAUTHENTICATED');
    }
    expect(mockCreateOrder).not.toHaveBeenCalled();
  });

  // Test 8
  it('rejects an empty cart with VALIDATION', async () => {
    authenticate();
    cartStore.current = { lines: [] };

    const result = await checkoutAction({});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
    }
    expect(mockCreateOrder).not.toHaveBeenCalled();
  });

  // Test 9
  it('ignores a cart supplied in the payload and uses the cookie', async () => {
    authenticate();
    cartStore.current = NON_EMPTY_CART;
    const foreignPayload = {
      cart: { lines: [{ kind: 'CATALOG_ITEM', catalogItemId: '99999999-9999-4999-8999-999999999999', quantity: 99 }] },
    };

    const result = await checkoutAction(foreignPayload);

    expect(result.ok).toBe(true);
    expect(mockCreateOrder).toHaveBeenCalledWith(expect.objectContaining({ cart: NON_EMPTY_CART }));
  });

  // Test 10 — SC-04's action-level assertion.
  it('passes no amounts to createOrder — only cart, identity fields, and the seat holder', async () => {
    authenticate();

    await checkoutAction({});

    expect(mockCreateOrder).toHaveBeenCalledTimes(1);
    const [callArgs] = mockCreateOrder.mock.calls[0] as [Record<string, unknown>];
    expect(Object.keys(callArgs).sort()).toEqual(
      ['cart', 'createdByCustomerId', 'householdId', 'seatHolder'].sort(),
    );
    expect(callArgs['cart']).toEqual(NON_EMPTY_CART);
    expect(callArgs['householdId']).toBe(FIXTURE_HOUSEHOLD_ID);
    expect(callArgs['createdByCustomerId']).toBe(FIXTURE_CUSTOMER_ID);
  });

  // Test 11
  it('passes the seat holder from the composition root', async () => {
    authenticate();
    const seatHolderInstance = { kind: 'seat-holder-instance' as const };
    mockGetSeatHolder.mockReturnValue(seatHolderInstance);

    await checkoutAction({});

    const [callArgs] = mockCreateOrder.mock.calls[0] as [Record<string, unknown>];
    expect(callArgs['seatHolder']).toBe(seatHolderInstance);
  });

  // Test 12
  it('never calls holdReservation directly', async () => {
    authenticate();

    await checkoutAction({});

    expect(mockHoldReservation).not.toHaveBeenCalled();
  });

  // Test 13
  it('surfaces a sold-out class as CONFLICT', async () => {
    authenticate();
    mockCreateOrder.mockRejectedValue(new CapacityExceededError(FIXTURE_OCCURRENCE_ID, 2));

    const result = await checkoutAction({});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('CONFLICT');
      expect(result.error.message.length).toBeGreaterThan(0);
    }
  });

  // Test 14
  it('surfaces a foreign participant as CONFLICT', async () => {
    authenticate();
    mockCreateOrder.mockRejectedValue(
      new ParticipantNotInHouseholdError({ kind: 'CUSTOMER', customerId: FIXTURE_FOREIGN_CUSTOMER_ID }),
    );

    const result = await checkoutAction({});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('CONFLICT');
    }
  });

  // Test 15 — SC-05.
  it("returns Square's checkout URL", async () => {
    authenticate();

    const result = await checkoutAction({});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.checkoutUrl).toBe(FIXTURE_CHECKOUT_URL);
    }
  });

  // Test 16
  it('derives the redirect URL from server configuration, never a request header', async () => {
    authenticate();
    process.env['APP_BASE_URL'] = FIXTURE_APP_BASE_URL;

    await checkoutAction({});

    expect(mockStartCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ redirectUrl: `${FIXTURE_APP_BASE_URL}/orders/${FIXTURE_ORDER_ID}` }),
    );
  });

  // Test 17
  it('targets the order status page', async () => {
    authenticate();

    await checkoutAction({});

    const [callArgs] = mockStartCheckout.mock.calls[0] as [{ redirectUrl: string }];
    expect(callArgs.redirectUrl.endsWith(`/orders/${FIXTURE_ORDER_ID}`)).toBe(true);
  });

  // Test 18
  it('clears the cart only after startCheckout succeeds', async () => {
    authenticate();

    await checkoutAction({});

    expect(mockClearCart).toHaveBeenCalledTimes(1);
  });

  it('leaves the cart intact when startCheckout fails', async () => {
    authenticate();
    mockStartCheckout.mockRejectedValue(new SquareApiError('createCheckout', new Error('boom')));
    const before = cartStore.current;

    await checkoutAction({});

    expect(mockClearCart).not.toHaveBeenCalled();
    expect(cartStore.current).toBe(before);
  });

  // Test 19
  it('surfaces a Square outage as UNAVAILABLE with the cart intact', async () => {
    authenticate();
    mockStartCheckout.mockRejectedValue(new SquareApiError('createCheckout', new Error('boom')));

    const result = await checkoutAction({});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNAVAILABLE');
    }
    expect(cartStore.current.lines).toEqual(NON_EMPTY_CART.lines);
  });
});
