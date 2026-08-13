import { describe, expect, it } from 'vitest';

const hasLiveDatabase =
  Boolean(process.env['DATABASE_URL_POOLED']) && Boolean(process.env['DATABASE_URL_DIRECT']);

// createSeatHolder is a thin adapter over holdReservation; what's worth
// testing here is specifically the port contract WS-05 depends on —
// honouring a caller-supplied transaction handle (down to real ROLLBACK) and
// returning the right HeldSeat shape — which requires a live Postgres
// transaction, not a mocked query builder. Skipped when Neon credentials are
// unset (e.g. locally); runs in CI once the branch is provisioned. Uses
// dynamic imports so a skipped run never triggers @keki/database's eager env
// validation at import time (see
// packages/notification-core/src/outbox.test.ts for the same pattern).
describe.skipIf(!hasLiveDatabase)('integration: createSeatHolder', () => {
  async function seedHouseholdAndCustomer() {
    const { db, households, customers } = await import('@keki/database');
    const [household] = await db
      .insert(households)
      .values({ name: `WS-06 SeatHolder Household ${crypto.randomUUID()}` })
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

  it('returns the reservation id and seat count matching the inserted row', async () => {
    const { createSeatHolder } = await import('./seat-holder');
    const { createCustomerId, createHouseholdId, createOccurrenceId } = await import('@keki/contracts');
    const { db, reservations } = await import('@keki/database');
    const { eq } = await import('drizzle-orm');

    const offering = await seedOffering();
    const occurrence = await seedOccurrence(offering.id);
    const { household, customer } = await seedHouseholdAndCustomer();
    const seatHolder = createSeatHolder();

    const held = await seatHolder.holdSeats({
      occurrenceId: createOccurrenceId(occurrence.id),
      householdId: createHouseholdId(household.id),
      createdByCustomerId: createCustomerId(customer.id),
      participants: [{ kind: 'CUSTOMER', customerId: createCustomerId(customer.id) }],
      holdTtlMinutes: 15,
      tx: undefined,
    });

    expect(held.occurrenceId).toBe(createOccurrenceId(occurrence.id));
    expect(held.seatCount).toBe(1);

    const [row] = await db.select().from(reservations).where(eq(reservations.id, held.reservationId));
    expect(row?.id).toBe(held.reservationId);
    expect(row?.seatCount).toBe(1);
  });

  it(
    'honours a supplied transaction: rolling it back leaves no reservation row',
    async () => {
      const { createSeatHolder } = await import('./seat-holder');
      const { createCustomerId, createHouseholdId, createOccurrenceId } = await import('@keki/contracts');
      const { db, reservations, withTransaction } = await import('@keki/database');
      const { eq } = await import('drizzle-orm');

      const offering = await seedOffering();
      const occurrence = await seedOccurrence(offering.id);
      const { household, customer } = await seedHouseholdAndCustomer();
      const seatHolder = createSeatHolder();

      class RollbackSentinel extends Error {}

      await expect(
        withTransaction(async (tx) => {
          await seatHolder.holdSeats({
            occurrenceId: createOccurrenceId(occurrence.id),
            householdId: createHouseholdId(household.id),
            createdByCustomerId: createCustomerId(customer.id),
            participants: [{ kind: 'CUSTOMER', customerId: createCustomerId(customer.id) }],
            holdTtlMinutes: 15,
            tx,
          });
          throw new RollbackSentinel();
        }),
      ).rejects.toBeInstanceOf(RollbackSentinel);

      const rows = await db.select().from(reservations).where(eq(reservations.occurrenceId, occurrence.id));
      expect(rows).toHaveLength(0);
    },
    10_000,
  );
});
