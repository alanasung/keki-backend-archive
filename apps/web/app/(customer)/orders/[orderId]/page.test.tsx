// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session, SessionResult } from '@keki/auth';
import {
  createChildId,
  createCustomerId,
  createHouseholdId,
  createOccurrenceId,
  createOrderId,
  createOrderLineItemId,
  createReservationId,
  type Child,
  type Customer,
  type Order,
  type OrderLineItem,
} from '@keki/contracts';

const HOUSEHOLD_ID = createHouseholdId('11111111-1111-4111-8111-111111111111');
const FOREIGN_HOUSEHOLD_ID = createHouseholdId('99999999-9999-4999-8999-999999999999');
const CUSTOMER_ID = createCustomerId('22222222-2222-4222-8222-222222222222');
const CHILD_ID = createChildId('33333333-3333-4333-8333-333333333333');
const ORDER_ID = createOrderId('44444444-4444-4444-8444-444444444444');
const OCCURRENCE_ID = createOccurrenceId('55555555-5555-4555-8555-555555555555');
const RESERVATION_ID = createReservationId('66666666-6666-4666-8666-666666666666');

const {
  mockGetSessionResult,
  mockGetOrderWithLineItems,
  mockTransitionOrder,
  mockListHouseholdMembers,
  mockListParticipantsForReservation,
  mockNotFound,
} = vi.hoisted(() => ({
  mockGetSessionResult: vi.fn(),
  mockGetOrderWithLineItems: vi.fn(),
  mockTransitionOrder: vi.fn(),
  mockListHouseholdMembers: vi.fn(),
  mockListParticipantsForReservation: vi.fn(),
  mockNotFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('../../../auth/require-session', () => ({ getSessionResult: mockGetSessionResult }));
vi.mock('@keki/commerce-core', () => ({
  getOrderWithLineItems: mockGetOrderWithLineItems,
  transitionOrder: mockTransitionOrder,
}));
vi.mock('@keki/customer-core', () => ({ listHouseholdMembers: mockListHouseholdMembers }));
vi.mock('@keki/reservation-core', () => ({ listParticipantsForReservation: mockListParticipantsForReservation }));
vi.mock('next/navigation', () => ({ notFound: mockNotFound }));

import OrderStatusPage from './page';

function fixtureSession(householdId = HOUSEHOLD_ID): Session {
  return {
    cognitoSub: 'cognito-sub-1',
    profile: {
      customerId: CUSTOMER_ID,
      householdId,
      email: 'ada@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
      role: 'CUSTOMER',
    },
  };
}

function authenticatedResult(householdId = HOUSEHOLD_ID): SessionResult {
  return { kind: 'authenticated', session: fixtureSession(householdId) };
}

function fixtureCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: CUSTOMER_ID,
    householdId: HOUSEHOLD_ID,
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

function fixtureChild(overrides: Partial<Child> = {}): Child {
  return {
    id: CHILD_ID,
    householdId: HOUSEHOLD_ID,
    firstName: 'Grace',
    lastName: 'Hopper',
    dateOfBirth: new Date('2018-01-01'),
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

function fixtureOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    householdId: HOUSEHOLD_ID,
    createdByCustomerId: CUSTOMER_ID,
    status: 'PAID',
    subtotalCents: 4500,
    currency: 'USD',
    squareOrderId: 'sq-order-1',
    squareCheckoutUrl: 'https://squareup.com/checkout/1',
    providerPaymentId: null,
    expiresAt: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

function fixtureLineItem(overrides: Partial<OrderLineItem> = {}): OrderLineItem {
  return {
    id: createOrderLineItemId('77777777-7777-4777-8777-777777777777'),
    orderId: ORDER_ID,
    kind: 'OCCURRENCE',
    catalogItemId: null,
    occurrenceId: OCCURRENCE_ID,
    reservationId: RESERVATION_ID,
    quantity: 1,
    unitPriceCents: 4500,
    nameSnapshot: 'Beginner Pottery',
    ...overrides,
  };
}

async function renderStatusPage(orderId: string = ORDER_ID) {
  return render(await OrderStatusPage({ params: Promise.resolve({ orderId }) }));
}

beforeEach(() => {
  mockGetSessionResult.mockReset().mockResolvedValue(authenticatedResult());
  mockGetOrderWithLineItems.mockReset().mockResolvedValue({ order: fixtureOrder(), lineItems: [fixtureLineItem()] });
  mockTransitionOrder.mockReset();
  mockListHouseholdMembers.mockReset().mockResolvedValue({ customers: [fixtureCustomer()], children: [fixtureChild()] });
  mockListParticipantsForReservation
    .mockReset()
    .mockResolvedValue([{ kind: 'CHILD', childId: CHILD_ID }]);
  mockNotFound.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('OrderStatusPage', () => {
  // Test 20
  it('shows a confirmation with line items and named participants for PAID', async () => {
    await renderStatusPage();

    expect(screen.getByText(/payment confirmed/i)).toBeInTheDocument();
    expect(screen.getByText('Beginner Pottery')).toBeInTheDocument();
    expect(screen.getByText(/Grace Hopper/)).toBeInTheDocument();
  });

  // Test 21
  it('shows a processing state, not an error, for AWAITING_PAYMENT', async () => {
    mockGetOrderWithLineItems.mockResolvedValue({
      order: fixtureOrder({ status: 'AWAITING_PAYMENT' }),
      lineItems: [fixtureLineItem()],
    });

    await renderStatusPage();

    expect(screen.getByText(/payment is processing/i)).toBeInTheDocument();
    expect(screen.queryByText(/error/i)).not.toBeInTheDocument();
  });

  // Test 22
  it('shows an incomplete state with a link back to the cart for DRAFT', async () => {
    mockGetOrderWithLineItems.mockResolvedValue({
      order: fixtureOrder({ status: 'DRAFT' }),
      lineItems: [fixtureLineItem()],
    });

    await renderStatusPage();

    expect(screen.getByText(/checkout was not completed/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /return to your cart/i })).toHaveAttribute('href', '/cart');
  });

  it('shows an explanation with a link to book for CANCELLED', async () => {
    mockGetOrderWithLineItems.mockResolvedValue({
      order: fixtureOrder({ status: 'CANCELLED' }),
      lineItems: [fixtureLineItem()],
    });

    await renderStatusPage();

    expect(screen.getByText(/this order was cancelled/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /book something new/i })).toHaveAttribute('href', '/book');
  });

  it('shows an explanation with a link to book for EXPIRED', async () => {
    mockGetOrderWithLineItems.mockResolvedValue({
      order: fixtureOrder({ status: 'EXPIRED' }),
      lineItems: [fixtureLineItem()],
    });

    await renderStatusPage();

    expect(screen.getByText(/never completed and expired/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /book something new/i })).toHaveAttribute('href', '/book');
  });

  // Test 23 — payment state comes only from WS-10's webhook.
  it('never transitions the order while rendering', async () => {
    await renderStatusPage();

    expect(mockTransitionOrder).not.toHaveBeenCalled();
  });

  // Test 24
  it('404s for another household\'s order', async () => {
    mockGetSessionResult.mockResolvedValue(authenticatedResult(FOREIGN_HOUSEHOLD_ID));

    await expect(renderStatusPage()).rejects.toThrow();

    expect(mockNotFound).toHaveBeenCalledTimes(1);
  });

  // Test 25
  it('404s for an unknown order id', async () => {
    mockGetOrderWithLineItems.mockResolvedValue(null);

    await expect(renderStatusPage()).rejects.toThrow();

    expect(mockNotFound).toHaveBeenCalledTimes(1);
  });

  it('404s for a malformed order id', async () => {
    await expect(renderStatusPage('not-a-uuid')).rejects.toThrow();

    expect(mockNotFound).toHaveBeenCalledTimes(1);
    expect(mockGetOrderWithLineItems).not.toHaveBeenCalled();
  });

  it('404s for an anonymous caller', async () => {
    mockGetSessionResult.mockResolvedValue({ kind: 'anonymous' });

    await expect(renderStatusPage()).rejects.toThrow();

    expect(mockNotFound).toHaveBeenCalledTimes(1);
  });
});
