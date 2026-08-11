import { describe, expect, it } from 'vitest';
import type { CartParticipantRef } from './catalog';
import {
  createChildId,
  createCustomerId,
  createHouseholdId,
  createOccurrenceId,
  createReservationId,
} from './ids';
import type { HeldSeat, SeatHolder } from './ports';

const VALID_OCCURRENCE_ID = '11111111-1111-4111-8111-111111111111';
const VALID_HOUSEHOLD_ID = '22222222-2222-4222-8222-222222222222';
const VALID_CUSTOMER_ID = '33333333-3333-4333-8333-333333333333';
const VALID_CHILD_ID = '44444444-4444-4444-8444-444444444444';
const VALID_RESERVATION_ID = '55555555-5555-4555-8555-555555555555';

describe('SeatHolder', () => {
  const occurrenceId = createOccurrenceId(VALID_OCCURRENCE_ID);
  const householdId = createHouseholdId(VALID_HOUSEHOLD_ID);
  const createdByCustomerId = createCustomerId(VALID_CUSTOMER_ID);
  const participants: readonly CartParticipantRef[] = [
    { kind: 'CHILD', childId: createChildId(VALID_CHILD_ID) },
  ];

  const seatHolder: SeatHolder = {
    holdSeats: (input) => {
      const held: HeldSeat = {
        occurrenceId: input.occurrenceId,
        reservationId: createReservationId(VALID_RESERVATION_ID),
        seatCount: input.participants.length,
      };
      return Promise.resolve(held);
    },
  };

  it('holds seats when a transaction scope is provided', async () => {
    const result = await seatHolder.holdSeats({
      occurrenceId,
      householdId,
      createdByCustomerId,
      participants,
      holdTtlMinutes: 15,
      tx: {},
    });
    expect(result.seatCount).toBe(1);
  });

  it('requires a transaction scope at compile time', () => {
    // @ts-expect-error - holdSeats must not compile without `tx`; that is
    // what keeps order creation and seat holding atomic.
    const call = seatHolder.holdSeats({
      occurrenceId,
      householdId,
      createdByCustomerId,
      participants,
      holdTtlMinutes: 15,
    });
    expect(call).toBeDefined();
  });
});
