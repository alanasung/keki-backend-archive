import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OccurrenceStatus, OfferingStatus, OfferingType, ReservationStatus } from '@keki/contracts';

const hasLiveDatabase =
  Boolean(process.env['DATABASE_URL_POOLED']) && Boolean(process.env['DATABASE_URL_DIRECT']);

// listBookableOfferings' correctness (the JOIN, the aggregate seat count,
// the capacity_override fallback) can't be faithfully verified against a
// stub query builder, so this suite runs against a live Neon branch and is
// skipped when those env vars are unset (e.g. locally without Neon
// credentials); it runs in CI once the branch is provisioned. Uses dynamic
// imports so a skipped run never triggers @keki/database's eager env
// validation at import time (see packages/notification-core/src/outbox.test.ts
// for the same pattern).
describe.skipIf(!hasLiveDatabase)('integration: catalog-core queries', () => {
  beforeEach(async () => {
    const { db, catalogItems, occurrences, offerings, reservations } = await import('@keki/database');
    await db.delete(reservations);
    await db.delete(occurrences);
    await db.delete(offerings);
    await db.delete(catalogItems);
  });

  describe('listCafeItems', () => {
    it('excludes archived rows', async () => {
      const { listCafeItems } = await import('./queries');
      const { db, catalogItems } = await import('@keki/database');

      await db.insert(catalogItems).values([
        {
          squareCatalogObjectId: `object-active-${crypto.randomUUID()}`,
          squareVariationId: `var-active-${crypto.randomUUID()}`,
          name: 'Active Muffin',
          priceCents: 350,
          status: 'ACTIVE',
        },
        {
          squareCatalogObjectId: `object-archived-${crypto.randomUUID()}`,
          squareVariationId: `var-archived-${crypto.randomUUID()}`,
          name: 'Archived Scone',
          priceCents: 300,
          status: 'ARCHIVED',
        },
      ]);

      const result = await listCafeItems();

      expect(result.map((row) => row.name)).toEqual(['Active Muffin']);
    });
  });

  describe('listBookableOfferings', () => {
    async function seedHouseholdAndCustomer() {
      const { db, households, customers } = await import('@keki/database');
      const [household] = await db
        .insert(households)
        .values({ name: `WS-04 Household ${crypto.randomUUID()}` })
        .returning();
      const [customer] = await db
        .insert(customers)
        .values({
          householdId: household!.id,
          cognitoSub: `cognito-${crypto.randomUUID()}`,
          firstName: 'Test',
          lastName: 'Customer',
        })
        .returning();
      return { household: household!, customer: customer! };
    }

    async function seedOffering(
      overrides: { status?: OfferingStatus; type?: OfferingType; defaultCapacity?: number } = {},
    ) {
      const { db, offerings } = await import('@keki/database');
      const [offering] = await db
        .insert(offerings)
        .values({
          slug: `offering-${crypto.randomUUID()}`,
          name: 'Test Class',
          type: overrides.type ?? 'CLASS',
          durationMinutes: 60,
          defaultCapacity: overrides.defaultCapacity ?? 5,
          priceCents: 2000,
          status: overrides.status ?? 'PUBLISHED',
        })
        .returning();
      return offering!;
    }

    async function seedOccurrence(
      offeringId: string,
      overrides: { startsAt?: Date; status?: OccurrenceStatus; capacityOverride?: number } = {},
    ) {
      const { db, occurrences } = await import('@keki/database');
      const startsAt = overrides.startsAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000);
      const [occurrence] = await db
        .insert(occurrences)
        .values({
          offeringId,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 60 * 60 * 1000),
          status: overrides.status ?? 'SCHEDULED',
          ...(overrides.capacityOverride !== undefined ? { capacityOverride: overrides.capacityOverride } : {}),
        })
        .returning();
      return occurrence!;
    }

    async function seedReservation(
      occurrenceId: string,
      householdId: string,
      createdByCustomerId: string,
      status: ReservationStatus,
      seatCount = 1,
    ) {
      const { db, reservations } = await import('@keki/database');
      await db.insert(reservations).values({ occurrenceId, householdId, createdByCustomerId, status, seatCount });
    }

    it('excludes unpublished offerings', async () => {
      const { listBookableOfferings } = await import('./queries');

      const draft = await seedOffering({ status: 'DRAFT' });
      await seedOccurrence(draft.id);
      const published = await seedOffering({ status: 'PUBLISHED' });
      await seedOccurrence(published.id);

      const result = await listBookableOfferings();

      expect(result.map((row) => row.offeringId)).toEqual([published.id]);
    });

    it('excludes past occurrences', async () => {
      const { listBookableOfferings } = await import('./queries');

      const offering = await seedOffering();
      await seedOccurrence(offering.id, { startsAt: new Date(Date.now() - 24 * 60 * 60 * 1000) });
      const tomorrow = await seedOccurrence(offering.id, { startsAt: new Date(Date.now() + 24 * 60 * 60 * 1000) });

      const result = await listBookableOfferings();

      expect(result.map((row) => row.occurrenceId)).toEqual([tomorrow.id]);
    });

    it('subtracts held and confirmed seats', async () => {
      const { listBookableOfferings } = await import('./queries');

      const { household, customer } = await seedHouseholdAndCustomer();
      const offering = await seedOffering({ defaultCapacity: 5 });
      const occurrence = await seedOccurrence(offering.id);
      await seedReservation(occurrence.id, household.id, customer.id, 'HELD', 1);
      await seedReservation(occurrence.id, household.id, customer.id, 'CONFIRMED', 2);

      const result = await listBookableOfferings();
      const row = result.find((r) => r.occurrenceId === occurrence.id);

      expect(row?.seatsRemaining).toBe(2);
    });

    it('ignores cancelled and no-show reservations', async () => {
      const { listBookableOfferings } = await import('./queries');

      const { household, customer } = await seedHouseholdAndCustomer();
      const offering = await seedOffering({ defaultCapacity: 5 });
      const occurrence = await seedOccurrence(offering.id);
      await seedReservation(occurrence.id, household.id, customer.id, 'CANCELLED', 3);
      await seedReservation(occurrence.id, household.id, customer.id, 'NO_SHOW', 3);

      const result = await listBookableOfferings();
      const row = result.find((r) => r.occurrenceId === occurrence.id);

      expect(row?.seatsRemaining).toBe(5);
    });

    it('honours capacity_override over default_capacity', async () => {
      const { listBookableOfferings } = await import('./queries');

      const { household, customer } = await seedHouseholdAndCustomer();
      const offering = await seedOffering({ defaultCapacity: 2 });
      const occurrence = await seedOccurrence(offering.id, { capacityOverride: 6 });
      await seedReservation(occurrence.id, household.id, customer.id, 'CONFIRMED', 1);

      const result = await listBookableOfferings();
      const row = result.find((r) => r.occurrenceId === occurrence.id);

      expect(row?.capacity).toBe(6);
      expect(row?.seatsRemaining).toBe(5);
    });

    it('clamps seatsRemaining at zero rather than going negative', async () => {
      const { listBookableOfferings } = await import('./queries');

      const { household, customer } = await seedHouseholdAndCustomer();
      const offering = await seedOffering({ defaultCapacity: 1 });
      const occurrence = await seedOccurrence(offering.id);
      await seedReservation(occurrence.id, household.id, customer.id, 'CONFIRMED', 5);

      const result = await listBookableOfferings();
      const row = result.find((r) => r.occurrenceId === occurrence.id);

      expect(row?.seatsRemaining).toBe(0);
    });

    it('respects seat_count rather than counting reservation rows', async () => {
      const { listBookableOfferings } = await import('./queries');

      const { household, customer } = await seedHouseholdAndCustomer();
      const offering = await seedOffering({ defaultCapacity: 5 });
      const occurrence = await seedOccurrence(offering.id);
      await seedReservation(occurrence.id, household.id, customer.id, 'CONFIRMED', 3);

      const result = await listBookableOfferings();
      const row = result.find((r) => r.occurrenceId === occurrence.id);

      expect(row?.seatsRemaining).toBe(2);
    });

    it('runs as a single query regardless of occurrence count (not N+1)', async () => {
      const { listBookableOfferings } = await import('./queries');

      const offering = await seedOffering();
      for (let i = 0; i < 20; i += 1) {
        await seedOccurrence(offering.id);
      }

      // The `db` client exported by @keki/database is a neon-http client: one
      // logical query is exactly one HTTP round trip. Spying on the platform
      // fetch (rather than a mock query builder) counts real round trips
      // against the live branch, so an N+1 regression fails this even if the
      // query-building code still only calls `.select()` once.
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      try {
        const result = await listBookableOfferings();
        expect(result.length).toBeGreaterThanOrEqual(20);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });
});
