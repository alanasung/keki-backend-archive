import { describe, expect, it } from 'vitest';

const hasLiveDatabase =
  Boolean(process.env['DATABASE_URL_POOLED']) && Boolean(process.env['DATABASE_URL_DIRECT']);

// SC-08's whole point is a property that only holds under real concurrent
// Postgres transactions racing the WS-02 capacity trigger
// (drizzle/0002_capacity_constraint.sql) — a mocked query builder cannot
// exercise the row lock these tests depend on. Runs against a live Neon
// branch and is skipped when those env vars are unset (e.g. locally without
// Neon credentials); runs in CI once the branch is provisioned. Uses dynamic
// imports so a skipped run never triggers @keki/database's eager env
// validation at import time (see
// packages/notification-core/src/outbox.test.ts for the same pattern).
describe.skipIf(!hasLiveDatabase)('integration: reservation concurrency (SC-08)', () => {
  async function seedHouseholdAndCustomer() {
    const { db, households, customers } = await import('@keki/database');
    const [household] = await db
      .insert(households)
      .values({ name: `WS-06 Concurrency Household ${crypto.randomUUID()}` })
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

  async function seedOffering(defaultCapacity: number) {
    const { db, offerings } = await import('@keki/database');
    const [offering] = await db
      .insert(offerings)
      .values({
        slug: `offering-${crypto.randomUUID()}`,
        name: 'Test Class',
        type: 'CLASS',
        durationMinutes: 60,
        defaultCapacity,
        priceCents: 2000,
        status: 'PUBLISHED',
      })
      .returning();
    return offering!;
  }

  async function seedOccurrence(offeringId: string) {
    const { db, occurrences } = await import('@keki/database');
    const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const [occurrence] = await db
      .insert(occurrences)
      .values({
        offeringId,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 60 * 60 * 1000),
        status: 'SCHEDULED',
      })
      .returning();
    return occurrence!;
  }

  async function ids() {
    const { createCustomerId, createHouseholdId, createOccurrenceId } = await import('@keki/contracts');
    return { createCustomerId, createHouseholdId, createOccurrenceId };
  }

  it(
    'two concurrent holds on a one-seat occurrence: exactly one wins',
    async () => {
      const { holdReservation } = await import('./commands');
      const { CapacityExceededError } = await import('./errors');
      const { db, reservations } = await import('@keki/database');
      const { eq, and } = await import('drizzle-orm');
      const { createCustomerId, createHouseholdId, createOccurrenceId } = await ids();

      const offering = await seedOffering(1);
      const occurrence = await seedOccurrence(offering.id);
      const { household, customer } = await seedHouseholdAndCustomer();
      const holdInput = {
        occurrenceId: createOccurrenceId(occurrence.id),
        householdId: createHouseholdId(household.id),
        createdByCustomerId: createCustomerId(customer.id),
        participants: [{ kind: 'CUSTOMER' as const, customerId: createCustomerId(customer.id) }],
      };

      const results = await Promise.allSettled([holdReservation(holdInput), holdReservation(holdInput)]);

      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      const rejected = results.filter((result) => result.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(CapacityExceededError);

      const heldRows = await db
        .select()
        .from(reservations)
        .where(and(eq(reservations.occurrenceId, occurrence.id), eq(reservations.status, 'HELD')));
      expect(heldRows).toHaveLength(1);
    },
    10_000,
  );

  it(
    'after payment, exactly one confirmed reservation exists for the occurrence (SC-08)',
    async () => {
      const { holdReservation, confirmReservation } = await import('./commands');
      const { db, reservations } = await import('@keki/database');
      const { eq, and } = await import('drizzle-orm');
      const { createCustomerId, createHouseholdId, createOccurrenceId } = await ids();

      const offering = await seedOffering(1);
      const occurrence = await seedOccurrence(offering.id);
      const { household, customer } = await seedHouseholdAndCustomer();
      const holdInput = {
        occurrenceId: createOccurrenceId(occurrence.id),
        householdId: createHouseholdId(household.id),
        createdByCustomerId: createCustomerId(customer.id),
        participants: [{ kind: 'CUSTOMER' as const, customerId: createCustomerId(customer.id) }],
      };

      const results = await Promise.allSettled([holdReservation(holdInput), holdReservation(holdInput)]);
      const winner = results.find(
        (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof holdReservation>>> =>
          result.status === 'fulfilled',
      );
      if (winner === undefined) {
        throw new Error('setup: expected exactly one holdReservation call to win the race');
      }

      await confirmReservation({ reservationId: winner.value.id });

      const confirmedRows = await db
        .select()
        .from(reservations)
        .where(and(eq(reservations.occurrenceId, occurrence.id), eq(reservations.status, 'CONFIRMED')));
      expect(confirmedRows).toHaveLength(1);
    },
    10_000,
  );

  it(
    'ten concurrent holds on a three-seat occurrence: exactly three win',
    async () => {
      const { holdReservation } = await import('./commands');
      const { CapacityExceededError } = await import('./errors');
      const { db, reservations } = await import('@keki/database');
      const { eq } = await import('drizzle-orm');
      const { createCustomerId, createHouseholdId, createOccurrenceId } = await ids();

      const offering = await seedOffering(3);
      const occurrence = await seedOccurrence(offering.id);
      const { household, customer } = await seedHouseholdAndCustomer();
      const holdInput = {
        occurrenceId: createOccurrenceId(occurrence.id),
        householdId: createHouseholdId(household.id),
        createdByCustomerId: createCustomerId(customer.id),
        participants: [{ kind: 'CUSTOMER' as const, customerId: createCustomerId(customer.id) }],
      };

      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () => holdReservation(holdInput)),
      );

      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      const rejected = results.filter((result) => result.status === 'rejected');
      expect(fulfilled).toHaveLength(3);
      expect(rejected).toHaveLength(7);
      for (const result of rejected) {
        expect(result.reason).toBeInstanceOf(CapacityExceededError);
      }

      const rows = await db.select().from(reservations).where(eq(reservations.occurrenceId, occurrence.id));
      const totalSeats = rows.reduce((sum, row) => sum + row.seatCount, 0);
      expect(totalSeats).toBe(3);
    },
    15_000,
  );
});
