import { eq } from 'drizzle-orm';
import { db, reservationParticipants, reservations } from '@keki/database';
import {
  createCustomerId,
  createOccurrenceId,
  createReservationId,
  type HouseholdId,
  type OccurrenceId,
  type Reservation,
  type ReservationId,
} from '@keki/contracts';

interface ReservationRow {
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
function toReservation(row: ReservationRow): Reservation {
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
// capacity limit and must not be mistaken for one; Phase 2 owns the actual
// capacity check (see the TODO in commands.ts on `holdReservation`).
export async function countConfirmedParticipants(occurrenceId: OccurrenceId): Promise<number> {
  const rows = await db
    .select({ status: reservations.status })
    .from(reservationParticipants)
    .innerJoin(reservations, eq(reservationParticipants.reservationId, reservations.id))
    .where(eq(reservations.occurrenceId, occurrenceId));

  return rows.filter((row) => row.status === 'CONFIRMED' || row.status === 'CHECKED_IN').length;
}
