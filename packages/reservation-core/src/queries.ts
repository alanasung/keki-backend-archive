import { eq, sql } from 'drizzle-orm';
import { db, occurrences, offerings, reservationParticipants, reservations } from '@keki/database';
import {
  createCustomerId,
  createOccurrenceId,
  createReservationId,
  type HouseholdId,
  type OccurrenceId,
  type Reservation,
  type ReservationId,
} from '@keki/contracts';

export interface ReservationRow {
  id: string;
  occurrenceId: string;
  createdByCustomerId: string;
  status: Reservation['status'];
  holdExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// The `reservations` table (WS-03) records `householdId` and
// `createdByCustomerId`; the `Reservation` contract (WS-02) predates that
// shape and only has a single `customerId`. `createdByCustomerId` — the
// customer who made the booking — is the closest match, so it fills that
// field here.
export function toReservation(row: ReservationRow): Reservation {
  return {
    id: createReservationId(row.id),
    occurrenceId: createOccurrenceId(row.occurrenceId),
    customerId: createCustomerId(row.createdByCustomerId),
    status: row.status,
    holdExpiresAt: row.holdExpiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getReservationById(id: ReservationId): Promise<Reservation | null> {
  const rows = await db.select().from(reservations).where(eq(reservations.id, id)).limit(1);
  const row = rows[0];
  return row === undefined ? null : toReservation(row);
}

export async function listReservationsForOccurrence(
  occurrenceId: OccurrenceId,
): Promise<readonly Reservation[]> {
  const rows = await db.select().from(reservations).where(eq(reservations.occurrenceId, occurrenceId));
  return rows.map(toReservation);
}

export async function listReservationsForHousehold(
  householdId: HouseholdId,
): Promise<readonly Reservation[]> {
  const rows = await db.select().from(reservations).where(eq(reservations.householdId, householdId));
  return rows.map(toReservation);
}

// Report only — this counts occupancy for display purposes. It enforces no
// capacity limit and must not be mistaken for one. The WS-02 trigger
// (drizzle/0002_capacity_constraint.sql), driven through `holdReservation`,
// is the actual capacity check — this function must not be repurposed as it.
export async function countConfirmedParticipants(occurrenceId: OccurrenceId): Promise<number> {
  const rows = await db
    .select({ status: reservations.status })
    .from(reservationParticipants)
    .innerJoin(reservations, eq(reservationParticipants.reservationId, reservations.id))
    .where(eq(reservations.occurrenceId, occurrenceId));

  return rows.filter((row) => row.status === 'CONFIRMED' || row.status === 'CHECKED_IN').length;
}

// The same status set the WS-02 capacity trigger counts (see
// drizzle/0002_capacity_constraint.sql), mirroring catalog-core's
// listBookableOfferings so the two never disagree about who owns a seat.
const SEAT_CONSUMING_STATUSES = ['HELD', 'CONFIRMED', 'CHECKED_IN'] as const;

// Display only — stale the instant it resolves; a concurrent hold can
// consume a seat before the caller's next statement. The WS-02 capacity
// trigger is the sole authority on whether a hold may proceed; this must
// never be mistaken for that check, mirroring the warning on
// countConfirmedParticipants above.
export async function getSeatsRemaining(occurrenceId: OccurrenceId): Promise<number> {
  const seatsConsumed = sql<number>`coalesce(sum(case when ${reservations.status} in ${SEAT_CONSUMING_STATUSES} then ${reservations.seatCount} else 0 end), 0)::int`;

  const rows = await db
    .select({
      defaultCapacity: offerings.defaultCapacity,
      capacityOverride: occurrences.capacityOverride,
      seatsConsumed,
    })
    .from(occurrences)
    .innerJoin(offerings, eq(occurrences.offeringId, offerings.id))
    .leftJoin(reservations, eq(reservations.occurrenceId, occurrences.id))
    .where(eq(occurrences.id, occurrenceId))
    .groupBy(occurrences.id, offerings.id);

  const row = rows[0];
  if (row === undefined) {
    return 0;
  }

  const capacity = row.capacityOverride ?? row.defaultCapacity;
  return Math.max(0, capacity - row.seatsConsumed);
}
