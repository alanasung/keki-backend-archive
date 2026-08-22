import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { catalogItems, db, occurrences, offerings, reservations } from '@keki/database';
import {
  createCatalogItemId,
  createOccurrenceId,
  createOfferingId,
  SEAT_CONSUMING_STATUSES,
  type BookableOccurrenceView,
  type CafeItemView,
  type OfferingType,
} from '@keki/contracts';

// This program sells classes only; rooms and open play remain
// display-only and are out of scope (WS-04 spec).
const DEFAULT_OFFERING_TYPES: readonly OfferingType[] = ['CLASS'];

// SEAT_CONSUMING_STATUSES comes from @keki/contracts: the capacity trigger,
// reservation-core, and catalog-admin all count the same set, and a local
// copy here would be free to drift from them silently.

export async function listCafeItems(): Promise<readonly CafeItemView[]> {
  const rows = await db
    .select({
      id: catalogItems.id,
      name: catalogItems.name,
      description: catalogItems.description,
      priceCents: catalogItems.priceCents,
      currency: catalogItems.currency,
    })
    .from(catalogItems)
    .where(eq(catalogItems.status, 'ACTIVE'))
    .orderBy(catalogItems.name);

  return rows.map((row) => ({
    catalogItemId: createCatalogItemId(row.id),
    name: row.name,
    description: row.description,
    priceCents: row.priceCents,
    currency: row.currency,
  }));
}

// seatsRemaining is display only and stale the moment this resolves — a
// concurrent hold can consume a seat between this read and the customer's
// next click. The WS-02 capacity trigger (0002_capacity_constraint.sql) is
// the authoritative check; this must never be mistaken for it, mirroring
// the warning on countConfirmedParticipants in reservation-core.
export async function listBookableOfferings(input?: {
  from?: Date;
  to?: Date;
  types?: readonly OfferingType[];
}): Promise<readonly BookableOccurrenceView[]> {
  const from = input?.from ?? new Date();
  const types = input?.types ?? DEFAULT_OFFERING_TYPES;

  const seatsConsumed = sql<number>`coalesce(sum(case when ${reservations.status} in ${SEAT_CONSUMING_STATUSES} then ${reservations.seatCount} else 0 end), 0)::int`;

  const rows = await db
    .select({
      occurrenceId: occurrences.id,
      offeringId: offerings.id,
      name: offerings.name,
      description: offerings.description,
      startsAt: occurrences.startsAt,
      endsAt: occurrences.endsAt,
      priceCents: offerings.priceCents,
      currency: offerings.currency,
      defaultCapacity: offerings.defaultCapacity,
      capacityOverride: occurrences.capacityOverride,
      seatsConsumed,
    })
    .from(occurrences)
    .innerJoin(offerings, eq(occurrences.offeringId, offerings.id))
    .leftJoin(reservations, eq(reservations.occurrenceId, occurrences.id))
    .where(
      and(
        eq(offerings.status, 'PUBLISHED'),
        eq(occurrences.status, 'SCHEDULED'),
        gte(occurrences.startsAt, from),
        inArray(offerings.type, [...types]),
        ...(input?.to !== undefined ? [lte(occurrences.startsAt, input.to)] : []),
      ),
    )
    .groupBy(occurrences.id, offerings.id)
    .orderBy(occurrences.startsAt);

  return rows.map((row) => {
    const capacity = row.capacityOverride ?? row.defaultCapacity;
    const seatsRemaining = Math.max(0, capacity - row.seatsConsumed);

    return {
      occurrenceId: createOccurrenceId(row.occurrenceId),
      offeringId: createOfferingId(row.offeringId),
      name: row.name,
      description: row.description,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      priceCents: row.priceCents,
      currency: row.currency,
      capacity,
      seatsRemaining,
    };
  });
}
