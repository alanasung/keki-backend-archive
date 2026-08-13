import { describe, expect, it } from 'vitest';

const hasLiveDatabase =
  Boolean(process.env['DATABASE_URL_POOLED']) && Boolean(process.env['DATABASE_URL_DIRECT']);

// getSeatsRemaining's correctness (the JOIN, the aggregate seat count, the
// capacity_override fallback) can't be faithfully verified against the
// mocked query builder queries.test.ts uses for the rest of this file's
// module — see packages/catalog-core/src/queries.test.ts's
// listBookableOfferings suite for the same query shape tested the same way.
// This lives in its own file (rather than queries.test.ts) because that
// file's module-scoped `vi.mock('@keki/database', ...)` would otherwise
// intercept these calls too — see
// packages/customer-core/src/commands.integration.test.ts for the same
// mocked/live split. Uses dynamic imports so a skipped run never triggers
// @keki/database's eager env validation at import time.
describe.skipIf(!hasLiveDatabase)('integration: getSeatsRemaining', () => {
  async function seedHouseholdAndCustomer() {
    const { db, households, customers } = await import('@keki/database');
    const [household] = await db
      .insert(households)
      .values({ name: `WS-06 Seats Household ${crypto.randomUUID()}` })
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

  async function seedOffering(defaultCapacity = 5) {
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

  async function seedReservation(
    occurrenceId: string,
    householdId: string,
    createdByCustomerId: string,
    status: 'HELD' | 'CONFIRMED' | 'CANCELLED',
    seatCount = 1,
  ) {
    const { db, reservations } = await import('@keki/database');
    await db.insert(reservations).values({ occurrenceId, householdId, createdByCustomerId, status, seatCount });
  }

  it('counts HELD seats but not CANCELLED, matching the trigger status set', async () => {
    const { getSeatsRemaining } = await import('./queries');
    const { createOccurrenceId } = await import('@keki/contracts');

    const offering = await seedOffering(5);
    const occurrence = await seedOccurrence(offering.id);
    const { household, customer } = await seedHouseholdAndCustomer();
    await seedReservation(occurrence.id, household.id, customer.id, 'HELD', 2);
    await seedReservation(occurrence.id, household.id, customer.id, 'CANCELLED', 3);

    const seatsRemaining = await getSeatsRemaining(createOccurrenceId(occurrence.id));

    expect(seatsRemaining).toBe(3);
  });
});
