import type { SeatHolder } from '@keki/contracts';
import { holdReservation } from './commands';

// A thin adapter over `holdReservation`. Kept thin deliberately: duplicating
// hold logic here would give two code paths that must both stay correct
// under concurrency, and `holdReservation` (via `insertHold` in commands.ts)
// is already the single place that does.
export function createSeatHolder(): SeatHolder {
  return {
    async holdSeats(input) {
      const reservation = await holdReservation({
        occurrenceId: input.occurrenceId,
        householdId: input.householdId,
        createdByCustomerId: input.createdByCustomerId,
        participants: input.participants,
        holdTtlMinutes: input.holdTtlMinutes,
        tx: input.tx,
      });

      return {
        occurrenceId: input.occurrenceId,
        reservationId: reservation.id,
        seatCount: input.participants.length,
      };
    },
  };
}
