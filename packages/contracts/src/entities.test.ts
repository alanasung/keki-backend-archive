import { describe, expect, it } from 'vitest';
import pkg from '../package.json';
import {
  createChildId,
  createCustomerId,
  createReservationId,
  createReservationParticipantId,
  type CustomerId,
} from './ids';
import {
  LEDGER_REASONS,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_STATUSES,
  OCCURRENCE_STATUSES,
  OFFERING_STATUSES,
  OFFERING_TYPES,
  PAYMENT_STATUSES,
  RESERVATION_STATUSES,
  WAIVER_STATUSES,
  createReservationSchema,
  type LedgerReason,
  type NotificationChannel,
  type NotificationStatus,
  type OccurrenceStatus,
  type OfferingStatus,
  type OfferingType,
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
    ]) {
      expect(tuple.length).toBeGreaterThan(0);
    }
  });
});

describe('package.json', () => {
  it('declares zod as the only runtime dependency', () => {
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(['zod']);
  });
});
