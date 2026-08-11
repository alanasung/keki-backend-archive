import { describe, expect, it } from 'vitest';
import pkg from '../package.json';
import type { SquareClient } from './integrations/square';
import {
  createCatalogItemId,
  createChildId,
  createCustomerId,
  createOrderId,
  createOrderLineItemId,
  createReservationId,
  createReservationParticipantId,
  type CustomerId,
} from './ids';
import {
  CATALOG_ITEM_STATUSES,
  LEDGER_REASONS,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_STATUSES,
  OCCURRENCE_STATUSES,
  OFFERING_STATUSES,
  OFFERING_TYPES,
  ORDER_LINE_ITEM_KINDS,
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  RESERVATION_STATUSES,
  WAIVER_STATUSES,
  createReservationSchema,
  type CatalogItemStatus,
  type LedgerReason,
  type NotificationChannel,
  type NotificationStatus,
  type OccurrenceStatus,
  type OfferingStatus,
  type OfferingType,
  type OrderLineItemKind,
  type OrderStatus,
  type PaymentStatus,
  type ReservationParticipant,
  type ReservationStatus,
  type WaiverStatus,
} from './entities';

const VALID_CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const VALID_CHILD_ID = '22222222-2222-4222-8222-222222222222';
const VALID_PARTICIPANT_ID = '33333333-3333-4333-8333-333333333333';
const VALID_RESERVATION_ID = '44444444-4444-4444-8444-444444444444';
const VALID_OCCURRENCE_ID = '55555555-5555-4555-8555-555555555555';
const VALID_ORDER_ID = '66666666-6666-4666-8666-666666666666';
const VALID_CATALOG_ITEM_ID = '77777777-7777-4777-8777-777777777777';
const VALID_ORDER_LINE_ITEM_ID = '88888888-8888-4888-8888-888888888888';

describe('branded ids', () => {
  it('rejects non-UUID input', () => {
    expect(() => createCustomerId('not-a-uuid')).toThrow();
  });

  it('accepts a valid v4 UUID', () => {
    expect(createCustomerId(VALID_CUSTOMER_ID)).toBe(VALID_CUSTOMER_ID);
  });

  it('does not allow interchanging branded ids at compile time', () => {
    const childId = createChildId(VALID_CHILD_ID);
    // @ts-expect-error - ChildId must not be assignable to CustomerId
    const customerId: CustomerId = childId;
    expect(customerId).toBeDefined();
  });

  it('rejects non-UUID input for the new order-domain ids', () => {
    expect(() => createOrderId('abc')).toThrow();
    expect(() => createCatalogItemId('abc')).toThrow();
    expect(() => createOrderLineItemId('abc')).toThrow();
  });

  it('round-trips a valid v4 UUID through the new order-domain id factories', () => {
    expect(createOrderId(VALID_ORDER_ID)).toBe(VALID_ORDER_ID);
    expect(createCatalogItemId(VALID_CATALOG_ITEM_ID)).toBe(VALID_CATALOG_ITEM_ID);
    expect(createOrderLineItemId(VALID_ORDER_LINE_ITEM_ID)).toBe(VALID_ORDER_LINE_ITEM_ID);
  });
});

describe('ReservationParticipant', () => {
  const base = {
    id: createReservationParticipantId(VALID_PARTICIPANT_ID),
    reservationId: createReservationId(VALID_RESERVATION_ID),
    createdAt: new Date(),
  };

  it('forbids setting both customerId and childId', () => {
    const customerId = createCustomerId(VALID_CUSTOMER_ID);
    const childId = createChildId(VALID_CHILD_ID);

    // @ts-expect-error - a participant cannot have both customerId and childId
    const both: ReservationParticipant = { ...base, customerId, childId };
    expect(both).toBeDefined();
  });

  it('forbids setting neither customerId nor childId', () => {
    // @ts-expect-error - a participant must set exactly one of customerId/childId
    const neither: ReservationParticipant = { ...base };
    expect(neither).toBeDefined();
  });
});

describe('createReservationSchema', () => {
  const validPayload = {
    occurrenceId: VALID_OCCURRENCE_ID,
    customerId: VALID_CUSTOMER_ID,
    participants: [{ customerId: VALID_CUSTOMER_ID }],
  };

  it('accepts a well-formed payload', () => {
    expect(createReservationSchema.safeParse(validPayload).success).toBe(true);
  });

  it('rejects a missing occurrenceId', () => {
    const { occurrenceId, ...withoutOccurrenceId } = validPayload;
    void occurrenceId;
    expect(createReservationSchema.safeParse(withoutOccurrenceId).success).toBe(false);
  });

  it('rejects an empty participant list', () => {
    expect(createReservationSchema.safeParse({ ...validPayload, participants: [] }).success).toBe(
      false,
    );
  });

  it('rejects a non-UUID id', () => {
    expect(
      createReservationSchema.safeParse({ ...validPayload, occurrenceId: 'not-a-uuid' }).success,
    ).toBe(false);
  });
});

describe('enum tuples', () => {
  const tuples: ReadonlyArray<readonly string[]> = [
    OFFERING_TYPES,
    OFFERING_STATUSES,
    OCCURRENCE_STATUSES,
    RESERVATION_STATUSES,
    LEDGER_REASONS,
    PAYMENT_STATUSES,
    NOTIFICATION_CHANNELS,
    NOTIFICATION_STATUSES,
    WAIVER_STATUSES,
    ORDER_STATUSES,
    ORDER_LINE_ITEM_KINDS,
    CATALOG_ITEM_STATUSES,
  ];

  it('has no duplicate members', () => {
    for (const tuple of tuples) {
      expect(new Set(tuple).size).toBe(tuple.length);
    }
  });

  it('every tuple member is assignable to its derived union type', () => {
    // Compile-time assertion: these assignments only typecheck if every tuple
    // member is a member of the derived union.
    const offeringTypes: readonly OfferingType[] = OFFERING_TYPES;
    const offeringStatuses: readonly OfferingStatus[] = OFFERING_STATUSES;
    const occurrenceStatuses: readonly OccurrenceStatus[] = OCCURRENCE_STATUSES;
    const reservationStatuses: readonly ReservationStatus[] = RESERVATION_STATUSES;
    const ledgerReasons: readonly LedgerReason[] = LEDGER_REASONS;
    const paymentStatuses: readonly PaymentStatus[] = PAYMENT_STATUSES;
    const notificationChannels: readonly NotificationChannel[] = NOTIFICATION_CHANNELS;
    const notificationStatuses: readonly NotificationStatus[] = NOTIFICATION_STATUSES;
    const waiverStatuses: readonly WaiverStatus[] = WAIVER_STATUSES;
    const orderStatuses: readonly OrderStatus[] = ORDER_STATUSES;
    const orderLineItemKinds: readonly OrderLineItemKind[] = ORDER_LINE_ITEM_KINDS;
    const catalogItemStatuses: readonly CatalogItemStatus[] = CATALOG_ITEM_STATUSES;

    for (const tuple of [
      offeringTypes,
      offeringStatuses,
      occurrenceStatuses,
      reservationStatuses,
      ledgerReasons,
      paymentStatuses,
      notificationChannels,
      notificationStatuses,
      waiverStatuses,
      orderStatuses,
      orderLineItemKinds,
      catalogItemStatuses,
    ]) {
      expect(tuple.length).toBeGreaterThan(0);
    }
  });
});

describe('package.json', () => {
  it('declares zod as the only runtime dependency', () => {
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(['zod']);
  });

  it('declares no Square SDK dependency', () => {
    const declared = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];
    expect(declared.some((name) => name.toLowerCase().includes('square'))).toBe(false);
  });
});

describe('SquareClient (widened checkout shape)', () => {
  it('no longer accepts a reservationId on createCheckout', () => {
    const client: SquareClient = {
      listCatalogItems: () => Promise.resolve({ items: [], cursor: null }),
      createCheckout: (input) => Promise.resolve({ checkoutUrl: '', squareOrderId: input.orderId }),
      getPayment: () => Promise.resolve(null),
      refundPayment: () => Promise.resolve({ refundId: '' }),
      verifyWebhookSignature: () => Promise.resolve(true),
    };

    const call = client.createCheckout({
      orderId: createOrderId(VALID_ORDER_ID),
      lineItems: [],
      currency: 'USD',
      idempotencyKey: 'key',
      redirectUrl: 'https://example.com',
      // @ts-expect-error - createCheckout no longer accepts reservationId;
      // a cafe order has no reservation.
      reservationId: createReservationId(VALID_RESERVATION_ID),
    });
    expect(call).toBeDefined();
  });
});
