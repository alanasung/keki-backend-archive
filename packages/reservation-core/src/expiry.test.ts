import { beforeEach, describe, expect, it } from 'vitest';

const hasLiveDatabase =
  Boolean(process.env['DATABASE_URL_POOLED']) && Boolean(process.env['DATABASE_URL_DIRECT']);

// expireStaleHolds' correctness rests on a real `FOR UPDATE SKIP LOCKED`
// statement (following claimDueNotifications in
// notification-core/src/outbox.ts) — no stub can faithfully imitate that, so
// this whole suite runs against a live Neon branch and is skipped when those
// env vars are unset (e.g. locally without Neon credentials); it runs in CI
// once the branch is provisioned. Uses dynamic imports so a skipped run
// never triggers @keki/database's eager env validation at import time (see
// packages/notification-core/src/outbox.test.ts for the same pattern).
describe.skipIf(!hasLiveDatabase)('integration: expireStaleHolds (SC-09)', () => {
  // `expireStaleHolds` sweeps every expired hold in the table, not just the
  // occurrence a given test seeded, so each test needs an empty table to
  // count against. Without this, holds accumulate across the file: "respects
  // the limit" deliberately leaves 7 of its 10 unexpired, and the sweep
  // below then found those plus its own 10 and reported 17.
  //
  // TRUNCATE rather than ordered DELETEs because `households` and
  // `customers` reference each other, so no delete order satisfies both.
  // Safe now that `pnpm test` runs one package at a time — see the root
  // test script and the comment on CI's test step.
  beforeEach(async () => {
    const { db } = await import('@keki/database');
    const { sql } = await import('drizzle-orm');
    await db.execute(sql`
      truncate table
        offerings, occurrences, reservations, reservation_participants,
        households, customers, children, orders, order_line_items
      restart identity cascade
    `);
  });

  async function seedHouseholdAndCustomer() {
    const { db, households, customers } = await import('@keki/database');
    const [household] = await db
      .insert(households)
      .values({ name: `WS-06 Expiry Household ${crypto.randomUUID()}` })
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
    status: 'HELD' | 'CONFIRMED',
    holdExpiresAt: Date | null,
    seatCount = 1,
  ) {
    const { db, reservations } = await import('@keki/database');
    const [reservation] = await db
      .insert(reservations)
      .values({ occurrenceId, householdId, createdByCustomerId, status, holdExpiresAt, seatCount })
      .returning();
    return reservation!;
  }

  it('cancels only expired holds, leaving a future hold untouched', async () => {
    const { expireStaleHolds } = await import('./expiry');
    const { db, reservations } = await import('@keki/database');
    const { eq } = await import('drizzle-orm');

    const offering = await seedOffering();
    const occurrence = await seedOccurrence(offering.id);
    const { household, customer } = await seedHouseholdAndCustomer();
    const now = new Date();

    const expired = await seedReservation(
      occurrence.id,
      household.id,
      customer.id,
      'HELD',
      new Date(now.getTime() - 60_000),
    );
    const future = await seedReservation(
      occurrence.id,
      household.id,
      customer.id,
      'HELD',
      new Date(now.getTime() + 60 * 60 * 1000),
    );

    const count = await expireStaleHolds({ now });

    expect(count).toBe(1);
    const [expiredRow] = await db.select().from(reservations).where(eq(reservations.id, expired.id));
    expect(expiredRow?.status).toBe('CANCELLED');
    const [futureRow] = await db.select().from(reservations).where(eq(reservations.id, future.id));
    expect(futureRow?.status).toBe('HELD');
  });

  it('frees the seat: expiring a hold at capacity lets a new hold succeed (SC-09)', async () => {
    const { expireStaleHolds } = await import('./expiry');
    const { holdReservation } = await import('./commands');
    const { createCustomerId, createHouseholdId, createOccurrenceId } = await import('@keki/contracts');

    const offering = await seedOffering(1);
    const occurrence = await seedOccurrence(offering.id);
    const { household, customer } = await seedHouseholdAndCustomer();
    const now = new Date();

    await seedReservation(occurrence.id, household.id, customer.id, 'HELD', new Date(now.getTime() - 60_000));

    await expireStaleHolds({ now });

    await expect(
      holdReservation({
        occurrenceId: createOccurrenceId(occurrence.id),
        householdId: createHouseholdId(household.id),
        createdByCustomerId: createCustomerId(customer.id),
        participants: [{ kind: 'CUSTOMER', customerId: createCustomerId(customer.id) }],
      }),
    ).resolves.toMatchObject({ status: 'HELD' });
  });

  it('ignores confirmed reservations even with a past holdExpiresAt', async () => {
    const { expireStaleHolds } = await import('./expiry');
    const { db, reservations } = await import('@keki/database');
    const { eq } = await import('drizzle-orm');

    const offering = await seedOffering();
    const occurrence = await seedOccurrence(offering.id);
    const { household, customer } = await seedHouseholdAndCustomer();
    const now = new Date();

    const confirmed = await seedReservation(
      occurrence.id,
      household.id,
      customer.id,
      'CONFIRMED',
      new Date(now.getTime() - 60_000),
    );

    await expireStaleHolds({ now });

    const [row] = await db.select().from(reservations).where(eq(reservations.id, confirmed.id));
    expect(row?.status).toBe('CONFIRMED');
  });

  it('respects the limit', async () => {
    const { expireStaleHolds } = await import('./expiry');

    // Capacity must cover all ten holds. The default of 5 predates the WS-02
    // trigger, which now rejects the sixth insert — the seeding fails before
    // the sweep under test ever runs.
    const offering = await seedOffering(10);
    const occurrence = await seedOccurrence(offering.id);
    const { household, customer } = await seedHouseholdAndCustomer();
    const now = new Date();

    for (let i = 0; i < 10; i += 1) {
      await seedReservation(occurrence.id, household.id, customer.id, 'HELD', new Date(now.getTime() - 60_000));
    }

    const count = await expireStaleHolds({ now, limit: 3 });

    expect(count).toBe(3);
  });

  it(
    'concurrent sweeps do not double-process: two sweeps over ten expired holds sum to ten with no overlap',
    async () => {
      const { expireStaleHolds } = await import('./expiry');

      // Capacity for all ten holds, as in "respects the limit" above.
      const offering = await seedOffering(10);
      const occurrence = await seedOccurrence(offering.id);
      const { household, customer } = await seedHouseholdAndCustomer();
      const now = new Date();

      for (let i = 0; i < 10; i += 1) {
        await seedReservation(occurrence.id, household.id, customer.id, 'HELD', new Date(now.getTime() - 60_000));
      }

      const [first, second] = await Promise.all([
        expireStaleHolds({ now, limit: 10 }),
        expireStaleHolds({ now, limit: 10 }),
      ]);

      expect(first + second).toBe(10);
    },
    10_000,
  );
});
