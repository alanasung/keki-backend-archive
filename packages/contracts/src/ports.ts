import type { CartParticipantRef } from './catalog';
import type { CustomerId, HouseholdId, OccurrenceId, ReservationId } from './ids';

/**
 * Opaque handle for an in-progress database transaction. Defined as unknown
 * so `contracts` needs no Drizzle dependency; the implementation narrows it.
 */
export type TransactionScope = unknown;

export interface HeldSeat {
  readonly occurrenceId: OccurrenceId;
  readonly reservationId: ReservationId;
  readonly seatCount: number;
}

// Lets `commerce-core` hold a seat without importing `reservation-core`,
// which the package boundary forbids (see AGENTS.md "Module boundaries").
// This mirrors how `dispatchNotification` receives `NotificationProviders`
// and `startCheckout` receives `SquareClient` — dependency inversion is the
// established idiom here, not a new pattern.
export interface SeatHolder {
  holdSeats(input: {
    readonly occurrenceId: OccurrenceId;
    readonly householdId: HouseholdId;
    readonly createdByCustomerId: CustomerId;
    readonly participants: readonly CartParticipantRef[];
    readonly holdTtlMinutes: number;
    // The point of this port: without a shared transaction, order creation
    // and seat holding cannot be made atomic, and a crash between them
    // would leave either a paid order with no seat or a held seat nobody
    // paid for.
    readonly tx: TransactionScope;
  }): Promise<HeldSeat>;
}
