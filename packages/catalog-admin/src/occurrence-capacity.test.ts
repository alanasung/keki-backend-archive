import { describe, expect, it } from 'vitest';
import type { ReservationStatus } from '@keki/contracts';

const hasLiveDatabase =
  Boolean(process.env['DATABASE_URL_POOLED']) && Boolean(process.env['DATABASE_URL_DIRECT']);

// Capacity edits interact with the WS-02 capacity trigger
// (packages/database/drizzle/0002_capacity_constraint.sql) and with real
// reservation rows, neither of which a stub query builder can faithfully
// imitate. Skipped when Neon credentials are unset (e.g. locally) and runs
// in CI once the branch is provisioned. Uses dynamic imports so a skipped
// run never triggers @keki/database's eager env validation at import time
// (see packages/notification-core/src/outbox.test.ts for the same pattern).
//
// Per-test crypto.randomUUID() identifiers isolate this suite from others
// sharing the CI branch, following commerce-core's approach.
describe.skipIf(!hasLiveDatabase)('integration: catalog-admin occurrence capacity', () => {
  // Seeds a real customer rather than a bare random id: WS-04 wires
  // recordAuditEntry into every command here, and staff_audit_log.actor_
  // customer_id is a real foreign key to customers — an unbacked id would
  // fail every mutation's audit insert, not just the mutation itself.
  async function actor() {
    const { db, households, customers } = await import('@keki/database');
    const { createCustomerId } = await import('@keki/contracts');
    const [household] = await db
      .insert(households)
      .values({ name: `WS-04 Actor Household ${crypto.randomUUID()}` })
      .returning();
    const [customer] = await db
      .insert(customers)
      .values({
        householdId: household!.id,
        cognitoSub: `staff-${crypto.randomUUID()}`,
        firstName: 'Staff',
        lastName: 'Actor',
      })
      .returning();
    return createCustomerId(customer!.id);
  }

  async function seedOffering(overrides: { defaultCapacity?: number } = {}) {
    const { db, offerings } = await import('@keki/database');
    const [offering] = await db
      .insert(offerings)
      .values({
        slug: `offering-${crypto.randomUUID()}`,
        name: `Test Class ${crypto.randomUUID()}`,
        type: 'CLASS',
        durationMinutes: 60,
        defaultCapacity: overrides.defaultCapacity ?? 8,
        priceCents: 2500,
        status: 'PUBLISHED',
      })
      .returning();
    return offering!;
  }

  async function seedHouseholdAndCustomer() {
    const { db, households, customers } = await import('@keki/database');
    const [household] = await db
      .insert(households)
      .values({ name: `WS-03 Household ${crypto.randomUUID()}` })
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

  function inMinutes(base: Date, minutes: number): Date {
    return new Date(base.getTime() + minutes * 60_000);
  }

  it('permits lowering capacity below the booked count and reports it (test 13, SC-08)', async () => {
    const { scheduleOccurrence, updateOccurrence } = await import('./occurrences');

    const offering = await seedOffering({ defaultCapacity: 8 });
    const actorCustomerId = await actor();
    const { household, customer } = await seedHouseholdAndCustomer();

    const created = await scheduleOccurrence({
      data: { offeringId: offering.id, startsAt: inMinutes(new Date(), 60), capacityOverride: null },
      actorCustomerId,
    });
    await seedReservation(created.id, household.id, customer.id, 'CONFIRMED', 3);

    const result = await updateOccurrence({
      occurrenceId: created.id,
      data: { capacityOverride: 2 },
      actorCustomerId,
    });

    expect(result.bookedSeats).toBe(3);
    expect(result.after.status).toBe('SCHEDULED');
  });

  it('leaves /book showing zero, not negative, after that edit (test 14, SC-08)', async () => {
    const { scheduleOccurrence, updateOccurrence } = await import('./occurrences');
    const { listBookableOfferings } = await import('@keki/catalog-core');

    const offering = await seedOffering({ defaultCapacity: 8 });
    const actorCustomerId = await actor();
    const { household, customer } = await seedHouseholdAndCustomer();

    const created = await scheduleOccurrence({
      data: { offeringId: offering.id, startsAt: inMinutes(new Date(), 60), capacityOverride: null },
      actorCustomerId,
    });
    await seedReservation(created.id, household.id, customer.id, 'CONFIRMED', 3);

    await updateOccurrence({
      occurrenceId: created.id,
      data: { capacityOverride: 2 },
      actorCustomerId,
    });

    const result = await listBookableOfferings();
    const row = result.find((r) => r.occurrenceId === created.id);

    expect(row?.seatsRemaining).toBe(0);
  });

  it('counts exactly the statuses the capacity trigger counts (test 15)', async () => {
    const { scheduleOccurrence, updateOccurrence } = await import('./occurrences');

    const offering = await seedOffering({ defaultCapacity: 8 });
    const actorCustomerId = await actor();
    const { household, customer } = await seedHouseholdAndCustomer();

    const created = await scheduleOccurrence({
      data: { offeringId: offering.id, startsAt: inMinutes(new Date(), 60), capacityOverride: null },
      actorCustomerId,
    });
    await seedReservation(created.id, household.id, customer.id, 'HELD', 1);
    await seedReservation(created.id, household.id, customer.id, 'CONFIRMED', 1);
    await seedReservation(created.id, household.id, customer.id, 'CANCELLED', 1);
    await seedReservation(created.id, household.id, customer.id, 'NO_SHOW', 1);

    const result = await updateOccurrence({ occurrenceId: created.id, data: {}, actorCustomerId });

    expect(result.bookedSeats).toBe(2);
  });

  it('sums seat_count rather than counting rows (test 16)', async () => {
    const { scheduleOccurrence, updateOccurrence } = await import('./occurrences');

    const offering = await seedOffering({ defaultCapacity: 8 });
    const actorCustomerId = await actor();
    const { household, customer } = await seedHouseholdAndCustomer();

    const created = await scheduleOccurrence({
      data: { offeringId: offering.id, startsAt: inMinutes(new Date(), 60), capacityOverride: null },
      actorCustomerId,
    });
    await seedReservation(created.id, household.id, customer.id, 'CONFIRMED', 3);

    const result = await updateOccurrence({ occurrenceId: created.id, data: {}, actorCustomerId });

    expect(result.bookedSeats).toBe(3);
  });
});
