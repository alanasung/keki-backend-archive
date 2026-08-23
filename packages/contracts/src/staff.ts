import { z } from 'zod';
import type { ReservationStatus } from './entities';

// ---------------------------------------------------------------------------
// Reservation transition table — expressed as data rather than scattered
// conditionals, mirroring OFFERING_TRANSITIONS in ./admin and
// ORDER_TRANSITIONS in ./orders. The `Record<ReservationStatus, ...>`
// annotation forces every status to have an entry — a missing one is a type
// error, not a silent gap.
//
// This table describes the whole reservation machine, but this program
// enforces it only at the staff boundary (WS-03). reservation-core's
// existing confirmReservation and cancelReservation are not modified here —
// retrofitting them is a separate change that would destabilize the
// checkout path this program does not otherwise touch. The table's edges
// therefore describe what reservation-core already does, not contradict it.
// ---------------------------------------------------------------------------

export const RESERVATION_TRANSITIONS: Readonly<
  Record<ReservationStatus, readonly ReservationStatus[]>
> = {
  HELD: ['CONFIRMED', 'CANCELLED'],
  // CHECKED_IN -> CONFIRMED is how undo works. Both statuses consume a
  // seat (see SEAT_CONSUMING_STATUSES), so the reversal cannot fail on
  // capacity.
  CONFIRMED: ['CHECKED_IN', 'CANCELLED', 'NO_SHOW'],
  CHECKED_IN: ['CONFIRMED'],
  // Terminal, matching what reservation-core's cancelReservation already
  // does.
  CANCELLED: [],
  // Terminal, deliberately. NO_SHOW is not seat-consuming, so reversing it
  // must re-acquire a seat that may already have been taken — the capacity
  // trigger would raise KEKI1 and the staff member would see a failure they
  // cannot act on. Correcting a mistaken no-show is out of scope for this
  // program; make it unrepresentable rather than half-supported.
  NO_SHOW: [],
} as const;

// HELD -> CHECKED_IN is deliberately absent above: a hold is an unfinished
// checkout, not an attendee; check-in must go through CONFIRMED.
export function canTransitionReservation(
  from: ReservationStatus,
  to: ReservationStatus,
): boolean {
  return RESERVATION_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Check-in input schemas — strict parsing so an unknown key fails loudly
// rather than being silently dropped.
//
// checkedInAt is not an input on any of these: the command stamps it from
// the server clock. Accepting it would let a caller backdate an attendance
// record, which is precisely the kind of claim an audit trail exists to
// make trustworthy.
//
// Check-in is keyed by participant, not by reservation plus a person
// reference. The participant row is the thing being marked, it already has
// an id, and keying by it makes "check in one of the three children on this
// booking" expressible without a compound lookup.
// ---------------------------------------------------------------------------

export const checkInParticipantSchema = z
  .object({
    reservationParticipantId: z.string().uuid(),
  })
  .strict();
export type CheckInParticipantInput = z.infer<typeof checkInParticipantSchema>;

export const undoCheckInParticipantSchema = checkInParticipantSchema;
export type UndoCheckInParticipantInput = z.infer<typeof undoCheckInParticipantSchema>;

export const markNoShowSchema = z
  .object({
    reservationId: z.string().uuid(),
  })
  .strict();
export type MarkNoShowInput = z.infer<typeof markNoShowSchema>;
