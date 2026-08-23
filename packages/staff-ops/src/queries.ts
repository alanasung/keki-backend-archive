import { and, asc, eq, gt, gte, inArray, lt, lte, ne, sql } from 'drizzle-orm';
import { children, customers, db, occurrences, offerings, reservationParticipants, reservations } from '@keki/database';
import {
  createOccurrenceId,
  createReservationId,
  createReservationParticipantId,
  SEAT_CONSUMING_STATUSES,
  type OccurrenceId,
  type OccurrenceStatus,
  type ReservationId,
  type ReservationParticipantId,
  type ReservationStatus,
} from '@keki/contracts';
import { cafeDayBounds } from './day-boundaries';

export interface StaffOccurrenceView {
  readonly occurrenceId: OccurrenceId;
  readonly offeringName: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly capacity: number;
  readonly expectedParticipants: number;
  readonly arrivedParticipants: number;
  readonly status: OccurrenceStatus;
}

// Both counts come from one aggregate query with conditional sums over the
// reservation_participants join, the same pattern as catalog-admin's
// bookedSeats — a count per occurrence would be N+1 on a busy Saturday.
// expectedParticipants agrees exactly with SEAT_CONSUMING_STATUSES so this
// view can never disagree with /admin/schedules about the same class.
export async function listTodaysOccurrences(input?: {
  now?: Date;
}): Promise<readonly StaffOccurrenceView[]> {
  const now = input?.now ?? new Date();
  const { start, end } = cafeDayBounds(now);

  const expectedParticipants = sql<number>`coalesce(sum(case when ${reservations.status} in ${SEAT_CONSUMING_STATUSES} then 1 else 0 end), 0)::int`;
  const arrivedParticipants = sql<number>`coalesce(sum(case when ${reservations.status} in ${SEAT_CONSUMING_STATUSES} and ${reservationParticipants.checkedInAt} is not null then 1 else 0 end), 0)::int`;

  const rows = await db
    .select({
      occurrenceId: occurrences.id,
      offeringName: offerings.name,
      startsAt: occurrences.startsAt,
      endsAt: occurrences.endsAt,
      defaultCapacity: offerings.defaultCapacity,
      capacityOverride: occurrences.capacityOverride,
      status: occurrences.status,
      expectedParticipants,
      arrivedParticipants,
    })
    .from(occurrences)
    .innerJoin(offerings, eq(occurrences.offeringId, offerings.id))
    .leftJoin(reservations, eq(reservations.occurrenceId, occurrences.id))
    .leftJoin(reservationParticipants, eq(reservationParticipants.reservationId, reservations.id))
    .where(and(gte(occurrences.startsAt, start), lt(occurrences.startsAt, end), ne(occurrences.status, 'CANCELLED')))
    .groupBy(occurrences.id, offerings.id)
    .orderBy(asc(occurrences.startsAt));

  return rows.map((row) => ({
    occurrenceId: createOccurrenceId(row.occurrenceId),
    offeringName: row.offeringName,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    capacity: row.capacityOverride ?? row.defaultCapacity,
    expectedParticipants: row.expectedParticipants,
    arrivedParticipants: row.arrivedParticipants,
    status: row.status,
  }));
}

export interface RosterParticipantView {
  readonly participantId: ReservationParticipantId;
  readonly reservationId: ReservationId;
  readonly displayName: string;
  readonly isChild: boolean;
  readonly checkedInAt: Date | null;
  readonly reservationStatus: ReservationStatus;
}

interface ParticipantNameRow {
  readonly childId: string | null;
  readonly customerFirstName: string | null;
  readonly customerLastName: string | null;
  readonly childFirstName: string | null;
  readonly childLastName: string | null;
}

// A child removed from a household after booking, or a customer similarly
// gone, is a real state — render the fallback rather than throw, mirroring
// occurrence-roster.tsx's `namesFor`. Both FKs are ON DELETE NO ACTION, so
// this join can never actually resolve to null through the app; exported so
// the fallback is unit-testable without forcing that unreachable state onto
// the live database.
export function resolveParticipantDisplayName(row: ParticipantNameRow): { displayName: string; isChild: boolean } {
  const isChild = row.childId !== null;
  const displayName = isChild
    ? row.childFirstName !== null && row.childLastName !== null
      ? `${row.childFirstName} ${row.childLastName}`
      : 'Unknown participant'
    : row.customerFirstName !== null && row.customerLastName !== null
      ? `${row.customerFirstName} ${row.customerLastName}`
      : 'Unknown participant';

  return { displayName, isChild };
}

// One query with two LEFT JOINs and a coalesce on the name, mirroring how
// occurrence-roster.tsx resolves participant names today: a participant row
// carries exactly one of customerId/childId, so exactly one join resolves.
export async function listOccurrenceRoster(
  occurrenceId: OccurrenceId,
): Promise<readonly RosterParticipantView[]> {
  const rows = await db
    .select({
      participantId: reservationParticipants.id,
      reservationId: reservations.id,
      reservationStatus: reservations.status,
      checkedInAt: reservationParticipants.checkedInAt,
      childId: reservationParticipants.childId,
      customerFirstName: customers.firstName,
      customerLastName: customers.lastName,
      childFirstName: children.firstName,
      childLastName: children.lastName,
    })
    .from(reservationParticipants)
    .innerJoin(reservations, eq(reservationParticipants.reservationId, reservations.id))
    .leftJoin(customers, eq(reservationParticipants.customerId, customers.id))
    .leftJoin(children, eq(reservationParticipants.childId, children.id))
    .where(and(eq(reservations.occurrenceId, occurrenceId), inArray(reservations.status, SEAT_CONSUMING_STATUSES)))
    // Checked-in last: staff work down the un-arrived, where the work is.
    .orderBy(sql`(${reservationParticipants.checkedInAt} is not null)`, reservationParticipants.createdAt);

  return rows.map((row) => {
    const { displayName, isChild } = resolveParticipantDisplayName(row);

    return {
      participantId: createReservationParticipantId(row.participantId),
      reservationId: createReservationId(row.reservationId),
      displayName,
      isChild,
      checkedInAt: row.checkedInAt,
      reservationStatus: row.reservationStatus,
    };
  });
}

export interface OccupancyLine {
  readonly occurrenceId: OccurrenceId;
  readonly offeringName: string;
  readonly endsAt: Date;
  readonly headcount: number;
}

export interface OccupancySnapshot {
  readonly asOf: Date;
  readonly totalHeadcount: number;
  readonly lines: readonly OccupancyLine[];
}

// There is no checked_out_at column and this program does not add one, so
// someone who leaves early still counts until their class ends — the
// `endsAt > now` bound is what makes that honest, letting the number
// self-clear instead of growing all day.
export async function getCurrentOccupancy(input?: { now?: Date }): Promise<OccupancySnapshot> {
  const now = input?.now ?? new Date();

  const headcount = sql<number>`coalesce(sum(case when ${reservationParticipants.checkedInAt} is not null then 1 else 0 end), 0)::int`;

  const rows = await db
    .select({
      occurrenceId: occurrences.id,
      offeringName: offerings.name,
      endsAt: occurrences.endsAt,
      headcount,
    })
    .from(occurrences)
    .innerJoin(offerings, eq(occurrences.offeringId, offerings.id))
    .leftJoin(reservations, eq(reservations.occurrenceId, occurrences.id))
    .leftJoin(reservationParticipants, eq(reservationParticipants.reservationId, reservations.id))
    .where(and(eq(occurrences.status, 'SCHEDULED'), lte(occurrences.startsAt, now), gt(occurrences.endsAt, now)))
    .groupBy(occurrences.id, offerings.id)
    .orderBy(asc(occurrences.startsAt));

  const lines: readonly OccupancyLine[] = rows.map((row) => ({
    occurrenceId: createOccurrenceId(row.occurrenceId),
    offeringName: row.offeringName,
    endsAt: row.endsAt,
    headcount: row.headcount,
  }));

  return {
    asOf: now,
    totalHeadcount: lines.reduce((sum, line) => sum + line.headcount, 0),
    lines,
  };
}
