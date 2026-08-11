import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCatalogItemId,
  createCustomerId,
  createHouseholdId,
  createOccurrenceId,
  createOrderId,
  createOrderLineItemId,
  createReservationId,
  type Order,
  type OrderLineItem,
  type ReservationId,
} from '@keki/contracts';

const {
  getOrderBySquareOrderIdMock,
  getOrderWithLineItemsMock,
  recordPaymentFromWebhookMock,
  transitionOrderMock,
  confirmReservationMock,
  holdReservationMock,
  enqueueNotificationMock,
  InvalidReservationTransitionError,
} = vi.hoisted(() => {
  // Defined inside `vi.hoisted` (rather than as a top-level class) because
  // `vi.mock` factories are hoisted above ordinary module code — a
  // top-level class declared below them would not exist yet when the
  // factory runs. It must be the *same* class fulfillment.ts sees via its
  // own `@keki/reservation-core` import, so both this file and
  // fulfillment.ts import it through the mock below rather than each
  // defining their own.
  class InvalidReservationTransitionError extends Error {
    readonly kind = 'InvalidReservationTransitionError';
    readonly reservationId: string;
    readonly fromStatus: string;
    readonly toStatus: string;

    constructor(reservationId: string, fromStatus: string, toStatus: string) {
      super(`Reservation "${reservationId}" cannot move from ${fromStatus} to ${toStatus}.`);
      this.name = 'InvalidReservationTransitionError';
      this.reservationId = reservationId;
      this.fromStatus = fromStatus;
      this.toStatus = toStatus;
    }
  }

  return {
    getOrderBySquareOrderIdMock: vi.fn(),
    getOrderWithLineItemsMock: vi.fn(),
    recordPaymentFromWebhookMock: vi.fn(),
    transitionOrderMock: vi.fn(),
    confirmReservationMock: vi.fn(),
    holdReservationMock: vi.fn(),
    enqueueNotificationMock: vi.fn(),
    InvalidReservationTransitionError,
  };
});

// Full replacement, not `importOriginal` — the real `@keki/commerce-core`,
// `@keki/reservation-core`, and `@keki/notification-core` modules all
// eagerly construct a Neon client at import time (see
// packages/database/src/client.ts), which throws without live
// DATABASE_URL_POOLED/DATABASE_URL_DIRECT env vars. A full replacement never
// evaluates the real module, so this suite runs with no database at all.
vi.mock('@keki/commerce-core', () => ({
  getOrderBySquareOrderId: getOrderBySquareOrderIdMock,
  getOrderWithLineItems: getOrderWithLineItemsMock,
  recordPaymentFromWebhook: recordPaymentFromWebhookMock,
  transitionOrder: transitionOrderMock,
}));

vi.mock('@keki/reservation-core', () => ({
  confirmReservation: confirmReservationMock,
  holdReservation: holdReservationMock,
  InvalidReservationTransitionError,
}));

vi.mock('@keki/notification-core', () => ({
  enqueueNotification: enqueueNotificationMock,
}));

import { fulfillPayment } from './fulfillment';

const ORDER_ID = createOrderId(randomUUID());
const HOUSEHOLD_ID = createHouseholdId(randomUUID());
const SQUARE_ORDER_ID = 'square-order-123';
const PROVIDER_PAYMENT_ID = 'square-payment-123';

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    householdId: HOUSEHOLD_ID,
    createdByCustomerId: createCustomerId(randomUUID()),
    status: 'AWAITING_PAYMENT',
    subtotalCents: 2500,
    currency: 'USD',
    squareOrderId: SQUARE_ORDER_ID,
    squareCheckoutUrl: 'https://square.example/checkout/1',
    providerPaymentId: null,
    expiresAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function makeLineItem(reservationId: ReservationId | null): OrderLineItem {
  return {
    id: createOrderLineItemId(randomUUID()),
    orderId: ORDER_ID,
    kind: reservationId === null ? 'CATALOG_ITEM' : 'OCCURRENCE',
    catalogItemId: reservationId === null ? createCatalogItemId(randomUUID()) : null,
    occurrenceId: reservationId === null ? null : createOccurrenceId(randomUUID()),
    reservationId,
    quantity: 1,
    unitPriceCents: 2500,
    nameSnapshot: 'Test line item',
  };
}

function baseInput(overrides: Partial<Parameters<typeof fulfillPayment>[0]> = {}) {
  return {
    squareOrderId: SQUARE_ORDER_ID,
    providerPaymentId: PROVIDER_PAYMENT_ID,
    amountCents: 2500,
    currency: 'USD',
    status: 'CAPTURED' as const,
    rawPayload: { id: PROVIDER_PAYMENT_ID },
    occurredAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  getOrderBySquareOrderIdMock.mockReset();
  getOrderWithLineItemsMock.mockReset();
  recordPaymentFromWebhookMock.mockReset();
  transitionOrderMock.mockReset();
  confirmReservationMock.mockReset();
  holdReservationMock.mockReset();
  enqueueNotificationMock.mockReset();
  process.env['STAFF_ALERT_EMAIL'] = 'staff@example.com';

  getOrderBySquareOrderIdMock.mockResolvedValue(makeOrder());
  recordPaymentFromWebhookMock.mockResolvedValue({ created: true, record: {} });
  transitionOrderMock.mockResolvedValue({ order: makeOrder({ status: 'PAID' }), changed: true });
  getOrderWithLineItemsMock.mockResolvedValue({ order: makeOrder({ status: 'PAID' }), lineItems: [] });
  confirmReservationMock.mockResolvedValue({ reservation: {}, changed: true });
});

describe('fulfillPayment', () => {
  it('a captured payment marks the order PAID and records the payment (SC-06, test 7)', async () => {
    const result = await fulfillPayment(baseInput());

    expect(recordPaymentFromWebhookMock).toHaveBeenCalledWith(
      expect.objectContaining({
        providerPaymentId: PROVIDER_PAYMENT_ID,
        householdId: HOUSEHOLD_ID,
        status: 'CAPTURED',
      }),
    );
    expect(transitionOrderMock).toHaveBeenCalledWith({
      orderId: ORDER_ID,
      to: 'PAID',
      expect: 'AWAITING_PAYMENT',
      patch: { providerPaymentId: PROVIDER_PAYMENT_ID },
    });
    expect(result.orderId).toBe(ORDER_ID);
  });

  it('resolves the order by squareOrderId, and the household comes from the resolved order (test 8)', async () => {
    await fulfillPayment(baseInput());

    expect(getOrderBySquareOrderIdMock).toHaveBeenCalledWith(SQUARE_ORDER_ID);
    expect(recordPaymentFromWebhookMock).toHaveBeenCalledWith(
      expect.objectContaining({ householdId: HOUSEHOLD_ID }),
    );
  });

  it('a pending payment does not transition the order (test 9)', async () => {
    await fulfillPayment(baseInput({ status: 'PENDING' }));

    expect(transitionOrderMock).not.toHaveBeenCalled();
  });

  it('a failed payment does not confirm reservations (test 10)', async () => {
    const reservationId = createReservationId(randomUUID());
    getOrderWithLineItemsMock.mockResolvedValue({
      order: makeOrder({ status: 'AWAITING_PAYMENT' }),
      lineItems: [makeLineItem(reservationId)],
    });

    await fulfillPayment(baseInput({ status: 'FAILED' }));

    expect(transitionOrderMock).not.toHaveBeenCalled();
    expect(confirmReservationMock).not.toHaveBeenCalled();
  });

  it('confirms every occurrence line reservation on a paid order (SC-07, test 11)', async () => {
    const reservationId1 = createReservationId(randomUUID());
    const reservationId2 = createReservationId(randomUUID());
    getOrderWithLineItemsMock.mockResolvedValue({
      order: makeOrder({ status: 'PAID' }),
      lineItems: [makeLineItem(reservationId1), makeLineItem(reservationId2)],
    });

    const result = await fulfillPayment(baseInput());

    expect(confirmReservationMock).toHaveBeenCalledTimes(2);
    expect(confirmReservationMock).toHaveBeenCalledWith({ reservationId: reservationId1 });
    expect(confirmReservationMock).toHaveBeenCalledWith({ reservationId: reservationId2 });
    expect(result.confirmed).toBe(2);
  });

  it('confirms nothing for a cafe-only order but still succeeds PAID (test 12)', async () => {
    getOrderWithLineItemsMock.mockResolvedValue({
      order: makeOrder({ status: 'PAID' }),
      lineItems: [makeLineItem(null), makeLineItem(null)],
    });

    const result = await fulfillPayment(baseInput());

    expect(confirmReservationMock).not.toHaveBeenCalled();
    expect(result.orderId).toBe(ORDER_ID);
    expect(result.confirmed).toBe(0);
  });

  it('replaying the same webhook produces one payment record call each, with the second transition and confirmation reporting changed:false (test 13, SC-13 replay)', async () => {
    const reservationId = createReservationId(randomUUID());
    recordPaymentFromWebhookMock
      .mockResolvedValueOnce({ created: true, record: {} })
      .mockResolvedValueOnce({ created: false, record: {} });
    transitionOrderMock
      .mockResolvedValueOnce({ order: makeOrder({ status: 'PAID' }), changed: true })
      .mockResolvedValueOnce({ order: makeOrder({ status: 'PAID' }), changed: false });
    getOrderWithLineItemsMock.mockResolvedValue({
      order: makeOrder({ status: 'PAID' }),
      lineItems: [makeLineItem(reservationId)],
    });
    confirmReservationMock
      .mockResolvedValueOnce({ reservation: {}, changed: true })
      .mockResolvedValueOnce({ reservation: {}, changed: false });

    const first = await fulfillPayment(baseInput());
    const second = await fulfillPayment(baseInput());

    expect(recordPaymentFromWebhookMock).toHaveBeenCalledTimes(2);
    expect(transitionOrderMock).toHaveBeenCalledTimes(2);
    expect(await transitionOrderMock.mock.results[1]!.value).toEqual(
      expect.objectContaining({ changed: false }),
    );
    expect(confirmReservationMock).toHaveBeenCalledTimes(2);
    expect(first.confirmed).toBe(1);
    expect(second.confirmed).toBe(1);
  });

  it('a crash after PAID still confirms outstanding reservations on retry, despite changed:false (test 13a, SC-13 resume)', async () => {
    const reservationId = createReservationId(randomUUID());
    transitionOrderMock
      .mockResolvedValueOnce({ order: makeOrder({ status: 'PAID' }), changed: true })
      .mockResolvedValueOnce({ order: makeOrder({ status: 'PAID' }), changed: false });
    getOrderWithLineItemsMock.mockResolvedValue({
      order: makeOrder({ status: 'PAID' }),
      lineItems: [makeLineItem(reservationId)],
    });
    confirmReservationMock
      .mockRejectedValueOnce(new Error('simulated crash'))
      .mockResolvedValueOnce({ reservation: {}, changed: true });

    await expect(fulfillPayment(baseInput())).rejects.toThrow('simulated crash');
    const result = await fulfillPayment(baseInput());

    expect(transitionOrderMock).toHaveBeenCalledTimes(2);
    expect(confirmReservationMock).toHaveBeenCalledTimes(2);
    expect(result.confirmed).toBe(1);
  });

  it('a partial confirmation completes on retry without losing the first (test 13b)', async () => {
    const reservationId1 = createReservationId(randomUUID());
    const reservationId2 = createReservationId(randomUUID());
    getOrderWithLineItemsMock.mockResolvedValue({
      order: makeOrder({ status: 'PAID' }),
      lineItems: [makeLineItem(reservationId1), makeLineItem(reservationId2)],
    });
    confirmReservationMock
      .mockResolvedValueOnce({ reservation: {}, changed: true }) // line 1, attempt 1
      .mockRejectedValueOnce(new Error('simulated crash')) // line 2, attempt 1
      .mockResolvedValueOnce({ reservation: {}, changed: false }) // line 1, attempt 2 (already confirmed)
      .mockResolvedValueOnce({ reservation: {}, changed: true }); // line 2, attempt 2

    await expect(fulfillPayment(baseInput())).rejects.toThrow('simulated crash');
    const result = await fulfillPayment(baseInput());

    expect(confirmReservationMock).toHaveBeenCalledTimes(4);
    expect(confirmReservationMock).toHaveBeenNthCalledWith(3, { reservationId: reservationId1 });
    expect(confirmReservationMock).toHaveBeenNthCalledWith(4, { reservationId: reservationId2 });
    expect(result.confirmed).toBe(2);
  });

  it('acknowledges an unmatched Square order without throwing (test 14)', async () => {
    getOrderBySquareOrderIdMock.mockResolvedValue(null);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await fulfillPayment(baseInput());

    expect(result).toEqual({ orderId: null, confirmed: 0 });
    expect(recordPaymentFromWebhookMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('logs and enqueues an outbox notification for an expired hold, without failing the message (test 15)', async () => {
    const reservationId = createReservationId(randomUUID());
    getOrderWithLineItemsMock.mockResolvedValue({
      order: makeOrder({ status: 'PAID' }),
      lineItems: [makeLineItem(reservationId)],
    });
    confirmReservationMock.mockRejectedValue(
      new InvalidReservationTransitionError(reservationId, 'CANCELLED', 'CONFIRMED'),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await fulfillPayment(baseInput());

    expect(errorSpy).toHaveBeenCalled();
    expect(enqueueNotificationMock).toHaveBeenCalledTimes(1);
    const [call] = enqueueNotificationMock.mock.calls[0] as [
      { channel: string; recipientAddress: string; payload: Record<string, unknown> },
    ];
    expect(call.channel).toBe('EMAIL');
    expect(call.recipientAddress).toBe('staff@example.com');
    expect(call.payload).toEqual(
      expect.objectContaining({ orderId: ORDER_ID, reservationId }),
    );
    expect(result.orderId).toBe(ORDER_ID);
    errorSpy.mockRestore();
  });

  it('never re-holds an expired reservation after a failed confirmation (test 16)', async () => {
    const reservationId = createReservationId(randomUUID());
    getOrderWithLineItemsMock.mockResolvedValue({
      order: makeOrder({ status: 'PAID' }),
      lineItems: [makeLineItem(reservationId)],
    });
    confirmReservationMock.mockRejectedValue(
      new InvalidReservationTransitionError(reservationId, 'CANCELLED', 'CONFIRMED'),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await fulfillPayment(baseInput());

    expect(holdReservationMock).not.toHaveBeenCalled();
  });
});
