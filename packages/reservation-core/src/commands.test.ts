import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CartParticipantRef, OfferingStatus, OfferingType } from '@keki/contracts';

const hasLiveDatabase =
  Boolean(process.env['DATABASE_URL_POOLED']) && Boolean(process.env['DATABASE_URL_DIRECT']);

// holdReservation/confirmReservation/cancelReservation all rest on the WS-02
// capacity trigger and, for holdReservation, a real Postgres transaction
// (drizzle/0002_capacity_constraint.sql; @keki/database's withTransaction) —
// neither is meaningful against a stub query builder, so this whole suite
// runs against a live Neon branch and is skipped when those env vars are
// unset (e.g. locally without Neon credentials); it runs in CI once the
// branch is provisioned. Uses dynamic imports so a skipped run never
// triggers @keki/database's eager env validation at import time (see
// packages/notification-core/src/outbox.test.ts for the same pattern).
describe.skipIf(!hasLiveDatabase)('integration: reservation commands', () => {
  beforeEach(async () => {
    const {
      db,
      reservationParticipants,
      reservations,
      children,
      customers,
      households,
      occurrences,
      offerings,
    } = await import('@keki/database');
    await db.delete(reservationParticipants);
    await db.delete(reservations);
    await db.delete(children);
    await db.delete(customers);
    await db.delete(households);
    await db.delete(occurrences);
    await db.delete(offerings);
  });

  async function seedHouseholdAndCustomer() {
    const { db, households, customers } = await import('@keki/database');
    const [household] = await db
      .insert(households)
      .values({ name: `WS-06 Household ${crypto.randomUUID()}` })
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

  async function seedChild(householdId: string) {
    const { db, children } = await import('@keki/database');
    const [child] = await db
      .insert(children)
      .values({
        householdId,
        firstName: 'Test',
        lastName: 'Child',
        dateOfBirth: '2018-01-01',
      })
      .returning();
    return child!;
  }

  async function seedOffering(
    overrides: { defaultCapacity?: number; status?: OfferingStatus; type?: OfferingType } = {},
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
    const { createCustomerId, createHouseholdId, createOccurrenceId, createChildId } = await import(
      '@keki/contracts'
    );
    return { createCustomerId, createHouseholdId, createOccurrenceId, createChildId };
  }

  describe('holdReservation', () => {
    it('creates a HELD row with seatCount and holdExpiresAt', async () => {
      const { holdReservation } = await import('./commands');
      const { db, reservations } = await import('@keki/database');
      const { eq } = await import('drizzle-orm');
      const { createCustomerId, createHouseholdId, createOccurrenceId } = await ids();

      const offering = await seedOffering();
      const occurrence = await seedOccurrence(offering.id);
      const { household, customer } = await seedHouseholdAndCustomer();
      const now = new Date('2026-01-01T00:00:00.000Z');

      const reservation = await holdReservation({
        occurrenceId: createOccurrenceId(occurrence.id),
        householdId: createHouseholdId(household.id),
        createdByCustomerId: createCustomerId(customer.id),
        participants: [{ kind: 'CUSTOMER', customerId: createCustomerId(customer.id) }],
        now,
        holdTtlMinutes: 15,
      });

      expect(reservation.status).toBe('HELD');
      expect(reservation.holdExpiresAt?.toISOString()).toBe(
        new Date(now.getTime() + 15 * 60_000).toISOString(),
      );

      const [row] = await db.select().from(reservations).where(eq(reservations.id, reservation.id));
      expect(row?.seatCount).toBe(1);
    });

    it('inserts one participant row per participant, mapped to the customer-XOR-child columns', async () => {
      const { holdReservation } = await import('./commands');
      const { db, reservationParticipants } = await import('@keki/database');
      const { eq } = await import('drizzle-orm');
      const { createCustomerId, createHouseholdId, createOccurrenceId, createChildId } = await ids();

      const offering = await seedOffering({ defaultCapacity: 5 });
      const occurrence = await seedOccurrence(offering.id);
      const { household, customer } = await seedHouseholdAndCustomer();
      const child = await seedChild(household.id);

      const participants: readonly CartParticipantRef[] = [
        { kind: 'CUSTOMER', customerId: createCustomerId(customer.id) },
        { kind: 'CHILD', childId: createChildId(child.id) },
      ];

      const reservation = await holdReservation({
        occurrenceId: createOccurrenceId(occurrence.id),
        householdId: createHouseholdId(household.id),
        createdByCustomerId: createCustomerId(customer.id),
        participants,
      });

      const rows = await db
        .select()
        .from(reservationParticipants)
        .where(eq(reservationParticipants.reservationId, reservation.id));

      expect(rows).toHaveLength(2);
      const customerRow = rows.find((row) => row.customerId === customer.id);
      const childRow = rows.find((row) => row.childId === child.id);
      expect(customerRow?.childId).toBeNull();
      expect(childRow?.customerId).toBeNull();
    });

    it('is atomic: a participant insert failure leaves no reservation row behind', async () => {
      const { holdReservation } = await import('./commands');
      const { db, reservations } = await import('@keki/database');
      const { eq } = await import('drizzle-orm');
      const { createCustomerId, createHouseholdId, createOccurrenceId, createChildId } = await ids();

      const offering = await seedOffering({ defaultCapacity: 5 });
      const occurrence = await seedOccurrence(offering.id);
      const { household, customer } = await seedHouseholdAndCustomer();

      // A childId that does not exist in `children` — the FK on
      // reservation_participants.child_id fails, forcing the participant
      // insert to reject after the reservations insert already succeeded.
      await expect(
        holdReservation({
          occurrenceId: createOccurrenceId(occurrence.id),
          householdId: createHouseholdId(household.id),
          createdByCustomerId: createCustomerId(customer.id),
          participants: [{ kind: 'CHILD', childId: createChildId(crypto.randomUUID()) }],
        }),
      ).rejects.toThrow();

      const rows = await db.select().from(reservations).where(eq(reservations.occurrenceId, occurrence.id));
      expect(rows).toHaveLength(0);
    });

    it('rejects an empty participant list', async () => {
      const { holdReservation } = await import('./commands');
      const { EmptyParticipantsError } = await import('./errors');
      const { createCustomerId, createHouseholdId, createOccurrenceId } = await ids();

      const offering = await seedOffering();
      const occurrence = await seedOccurrence(offering.id);
      const { household, customer } = await seedHouseholdAndCustomer();

      await expect(
        holdReservation({
          occurrenceId: createOccurrenceId(occurrence.id),
          householdId: createHouseholdId(household.id),
          createdByCustomerId: createCustomerId(customer.id),
          participants: [],
        }),
      ).rejects.toBeInstanceOf(EmptyParticipantsError);
    });

    it('fills the last seat at capacity 1', async () => {
      const { holdReservation } = await import('./commands');
      const { createCustomerId, createHouseholdId, createOccurrenceId } = await ids();

      const offering = await seedOffering({ defaultCapacity: 1 });
      const occurrence = await seedOccurrence(offering.id);
      const { household, customer } = await seedHouseholdAndCustomer();

      const reservation = await holdReservation({
        occurrenceId: createOccurrenceId(occurrence.id),
        householdId: createHouseholdId(household.id),
        createdByCustomerId: createCustomerId(customer.id),
        participants: [{ kind: 'CUSTOMER', customerId: createCustomerId(customer.id) }],
      });

      expect(reservation.status).toBe('HELD');
    });

    it('raises CapacityExceededError, carrying the occurrence id, past capacity', async () => {
      const { holdReservation } = await import('./commands');
      const { CapacityExceededError } = await import('./errors');
      const { createCustomerId, createHouseholdId, createOccurrenceId } = await ids();

      const offering = await seedOffering({ defaultCapacity: 1 });
      const occurrence = await seedOccurrence(offering.id);
      const { household, customer } = await seedHouseholdAndCustomer();
      const occurrenceId = createOccurrenceId(occurrence.id);
      const holdInput = {
        occurrenceId,
        householdId: createHouseholdId(household.id),
        createdByCustomerId: createCustomerId(customer.id),
        participants: [{ kind: 'CUSTOMER' as const, customerId: createCustomerId(customer.id) }],
      };

      await holdReservation(holdInput);

      const error = await holdReservation(holdInput).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(CapacityExceededError);
      expect((error as InstanceType<typeof CapacityExceededError>).occurrenceId).toBe(occurrenceId);
    });

    it('respects seat_count: a 3-seat hold at capacity 3 blocks a further 1-seat hold', async () => {
      const { holdReservation } = await import('./commands');
      const { CapacityExceededError } = await import('./errors');
      const { createCustomerId, createHouseholdId, createOccurrenceId, createChildId } = await ids();

      const offering = await seedOffering({ defaultCapacity: 3 });
      const occurrence = await seedOccurrence(offering.id);
      const { household, customer } = await seedHouseholdAndCustomer();
      const childA = await seedChild(household.id);
      const childB = await seedChild(household.id);

      await holdReservation({
        occurrenceId: createOccurrenceId(occurrence.id),
        householdId: createHouseholdId(household.id),
        createdByCustomerId: createCustomerId(customer.id),
        participants: [
          { kind: 'CUSTOMER', customerId: createCustomerId(customer.id) },
          { kind: 'CHILD', childId: createChildId(childA.id) },
          { kind: 'CHILD', childId: createChildId(childB.id) },
        ],
      });

      await expect(
        holdReservation({
          occurrenceId: createOccurrenceId(occurrence.id),
          householdId: createHouseholdId(household.id),
          createdByCustomerId: createCustomerId(customer.id),
          participants: [{ kind: 'CUSTOMER', customerId: createCustomerId(customer.id) }],
        }),
      ).rejects.toBeInstanceOf(CapacityExceededError);
    });

    it('does not issue a SELECT before the INSERT (no pre-count)', async () => {
      const { holdReservation } = await import('./commands');
      const { withTransaction } = await import('@keki/database');
      const { createCustomerId, createHouseholdId, createOccurrenceId } = await ids();

      const offering = await seedOffering({ defaultCapacity: 1 });
      const occurrence = await seedOccurrence(offering.id);
      const { household, customer } = await seedHouseholdAndCustomer();

      await withTransaction(async (tx) => {
        const selectSpy = vi.spyOn(tx, 'select');

        await holdReservation({
          occurrenceId: createOccurrenceId(occurrence.id),
          householdId: createHouseholdId(household.id),
          createdByCustomerId: createCustomerId(customer.id),
          participants: [{ kind: 'CUSTOMER', customerId: createCustomerId(customer.id) }],
          tx,
        });

        expect(selectSpy).not.toHaveBeenCalled();
      });
    });
  });

  describe('confirmReservation', () => {
    it('promotes a HELD row to CONFIRMED and clears holdExpiresAt', async () => {
      const { holdReservation, confirmReservation } = await import('./commands');
      const { createCustomerId, createHouseholdId, createOccurrenceId } = await ids();

      const offering = await seedOffering();
      const occurrence = await seedOccurrence(offering.id);
      const { household, customer } = await seedHouseholdAndCustomer();

      const held = await holdReservation({
        occurrenceId: createOccurrenceId(occurrence.id),
        householdId: createHouseholdId(household.id),
        createdByCustomerId: createCustomerId(customer.id),
        participants: [{ kind: 'CUSTOMER', customerId: createCustomerId(customer.id) }],
      });

      const { reservation, changed } = await confirmReservation({ reservationId: held.id });

      expect(changed).toBe(true);
      expect(reservation.status).toBe('CONFIRMED');
      expect(reservation.holdExpiresAt).toBeNull();
    });

    it('is idempotent: confirming an already-confirmed reservation reports changed: false', async () => {
      const { holdReservation, confirmReservation } = await import('./commands');
      const { createCustomerId, createHouseholdId, createOccurrenceId } = await ids();

      const offering = await seedOffering();
      const occurrence = await seedOccurrence(offering.id);
      const { household, customer } = await seedHouseholdAndCustomer();

      const held = await holdReservation({
        occurrenceId: createOccurrenceId(occurrence.id),
        householdId: createHouseholdId(household.id),
        createdByCustomerId: createCustomerId(customer.id),
        participants: [{ kind: 'CUSTOMER', customerId: createCustomerId(customer.id) }],
      });
      await confirmReservation({ reservationId: held.id });

      const second = await confirmReservation({ reservationId: held.id });

      expect(second.changed).toBe(false);
      expect(second.reservation.status).toBe('CONFIRMED');
    });

    it('fails loudly confirming an already-cancelled hold', async () => {
      const { holdReservation, confirmReservation, cancelReservation } = await import('./commands');
      const { InvalidReservationTransitionError } = await import('./errors');
      const { createCustomerId, createHouseholdId, createOccurrenceId } = await ids();

      const offering = await seedOffering();
      const occurrence = await seedOccurrence(offering.id);
      const { household, customer } = await seedHouseholdAndCustomer();

      const held = await holdReservation({
        occurrenceId: createOccurrenceId(occurrence.id),
        householdId: createHouseholdId(household.id),
        createdByCustomerId: createCustomerId(customer.id),
        participants: [{ kind: 'CUSTOMER', customerId: createCustomerId(customer.id) }],
      });
      await cancelReservation({ reservationId: held.id, reason: 'customer request' });

      await expect(confirmReservation({ reservationId: held.id })).rejects.toBeInstanceOf(
        InvalidReservationTransitionError,
      );
    });
  });

  describe('cancelReservation', () => {
    it('frees the seat: cancelling a hold at capacity lets a new hold succeed', async () => {
      const { holdReservation, cancelReservation } = await import('./commands');
      const { createCustomerId, createHouseholdId, createOccurrenceId } = await ids();

      const offering = await seedOffering({ defaultCapacity: 1 });
      const occurrence = await seedOccurrence(offering.id);
      const { household, customer } = await seedHouseholdAndCustomer();
      const holdInput = {
        occurrenceId: createOccurrenceId(occurrence.id),
        householdId: createHouseholdId(household.id),
        createdByCustomerId: createCustomerId(customer.id),
        participants: [{ kind: 'CUSTOMER' as const, customerId: createCustomerId(customer.id) }],
      };

      const held = await holdReservation(holdInput);
      await cancelReservation({ reservationId: held.id, reason: 'customer request' });

      await expect(holdReservation(holdInput)).resolves.toMatchObject({ status: 'HELD' });
    });

    it('is idempotent: cancelling an already-cancelled reservation reports changed: false', async () => {
      const { holdReservation, cancelReservation } = await import('./commands');
      const { createCustomerId, createHouseholdId, createOccurrenceId } = await ids();

      const offering = await seedOffering();
      const occurrence = await seedOccurrence(offering.id);
      const { household, customer } = await seedHouseholdAndCustomer();

      const held = await holdReservation({
        occurrenceId: createOccurrenceId(occurrence.id),
        householdId: createHouseholdId(household.id),
        createdByCustomerId: createCustomerId(customer.id),
        participants: [{ kind: 'CUSTOMER', customerId: createCustomerId(customer.id) }],
      });
      await cancelReservation({ reservationId: held.id, reason: 'first cancel' });

      const second = await cancelReservation({ reservationId: held.id, reason: 'second cancel' });

      expect(second.changed).toBe(false);
      expect(second.reservation.status).toBe('CANCELLED');
    });
  });
});
