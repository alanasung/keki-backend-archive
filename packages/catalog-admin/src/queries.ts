import { asc, eq, gte, sql } from 'drizzle-orm';
import { db, occurrences, offerings, reservations } from '@keki/database';
import {
  createOccurrenceId,
  createOfferingId,
  SEAT_CONSUMING_STATUSES,
  type Occurrence,
  type OccurrenceId,
  type OccurrenceStatus,
  type Offering,
  type OfferingId,
  type OfferingStatus,
} from '@keki/contracts';

export interface OfferingRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  type: Offering['type'];
  durationMinutes: number;
  defaultCapacity: number;
  priceCents: number;
  currency: string;
  status: Offering['status'];
  createdAt: Date;
  updatedAt: Date;
}

export function toOffering(row: OfferingRow): Offering {
  return {
    id: createOfferingId(row.id),
    slug: row.slug,
    name: row.name,
    description: row.description,
    type: row.type,
    durationMinutes: row.durationMinutes,
    defaultCapacity: row.defaultCapacity,
    priceCents: row.priceCents,
    currency: row.currency,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getOfferingById(offeringId: OfferingId): Promise<Offering | null> {
  const rows = await db.select().from(offerings).where(eq(offerings.id, offeringId)).limit(1);
  const row = rows[0];
  return row === undefined ? null : toOffering(row);
}

// Deliberately unfiltered by status, unlike catalog-core's published-only
// reads (packages/catalog-core/src/queries.ts) — a manager comes to the
// admin list precisely to find drafts and archived offerings, not just what
// is currently for sale.
export async function listOfferings(): Promise<readonly Offering[]> {
  const rows = await db.select().from(offerings).orderBy(asc(offerings.name));
  return rows.map(toOffering);
}

export interface OccurrenceRow {
  id: string;
  offeringId: string;
  startsAt: Date;
  endsAt: Date;
  status: Occurrence['status'];
  createdAt: Date;
  updatedAt: Date;
}

export function toOccurrence(row: OccurrenceRow): Occurrence {
  return {
    id: createOccurrenceId(row.id),
    offeringId: createOfferingId(row.offeringId),
    status: row.status,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getOccurrenceById(occurrenceId: OccurrenceId): Promise<Occurrence | null> {
  const rows = await db.select().from(occurrences).where(eq(occurrences.id, occurrenceId)).limit(1);
  const row = rows[0];
  return row === undefined ? null : toOccurrence(row);
}

// SEAT_CONSUMING_STATUSES comes from @keki/contracts, so the admin list and
// /book cannot advertise a different seat count for the same class.

export interface AdminOccurrenceView {
  occurrenceId: OccurrenceId;
  offeringId: OfferingId;
  offeringName: string;
  offeringStatus: OfferingStatus;
  startsAt: Date;
  endsAt: Date;
  capacity: number;
  bookedSeats: number;
  status: OccurrenceStatus;
}

// Deliberately unfiltered by offering status, unlike catalog-core's
// listBookableOfferings — a manager needs to see what is scheduled against a
// draft or archived offering, exactly the state /book hides. Booked counts
// are computed in one aggregate query with a LEFT JOIN, not N+1 per
// occurrence.
export async function listUpcomingOccurrences(input?: {
  from?: Date;
  limit?: number;
}): Promise<readonly AdminOccurrenceView[]> {
  const from = input?.from ?? new Date();

  const bookedSeats = sql<number>`coalesce(sum(case when ${reservations.status} in ${SEAT_CONSUMING_STATUSES} then ${reservations.seatCount} else 0 end), 0)::int`;

  const query = db
    .select({
      occurrenceId: occurrences.id,
      offeringId: offerings.id,
      offeringName: offerings.name,
      offeringStatus: offerings.status,
      startsAt: occurrences.startsAt,
      endsAt: occurrences.endsAt,
      defaultCapacity: offerings.defaultCapacity,
      capacityOverride: occurrences.capacityOverride,
      status: occurrences.status,
      bookedSeats,
    })
    .from(occurrences)
    .innerJoin(offerings, eq(occurrences.offeringId, offerings.id))
    .leftJoin(reservations, eq(reservations.occurrenceId, occurrences.id))
    .where(gte(occurrences.startsAt, from))
    .groupBy(occurrences.id, offerings.id)
    .orderBy(asc(occurrences.startsAt));

  const rows = input?.limit !== undefined ? await query.limit(input.limit) : await query;

  return rows.map((row) => ({
    occurrenceId: createOccurrenceId(row.occurrenceId),
    offeringId: createOfferingId(row.offeringId),
    offeringName: row.offeringName,
    offeringStatus: row.offeringStatus,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    capacity: row.capacityOverride ?? row.defaultCapacity,
    bookedSeats: row.bookedSeats,
    status: row.status,
  }));
}
