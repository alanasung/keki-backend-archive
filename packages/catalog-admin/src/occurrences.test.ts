import { describe, expect, it, vi } from 'vitest';
import type { OfferingStatus, ReservationStatus } from '@keki/contracts';

const hasLiveDatabase =
  Boolean(process.env['DATABASE_URL_POOLED']) && Boolean(process.env['DATABASE_URL_DIRECT']);

// Every function under test reads or writes real `occurrences` rows, and
// several assertions (overlap refusal, the guarded cancellation UPDATE) rely
// on real Postgres row semantics no stub can faithfully imitate. Skipped
// when Neon credentials are unset (e.g. locally) and runs in CI once the
// branch is provisioned. Uses dynamic imports so a skipped run never
// triggers @keki/database's eager env validation at import time (see
// packages/notification-core/src/outbox.test.ts for the same pattern).
//
// Follows commerce-core's isolation approach — per-test crypto.randomUUID()
// identifiers, scoped assertions to the offering(s) each test creates —
// rather than truncation, so this suite cannot disturb others sharing the
// CI branch.
describe.skipIf(!hasLiveDatabase)('integration: catalog-admin occurrences', () => {
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

  async function seedOffering(
    overrides: { status?: OfferingStatus; durationMinutes?: number; defaultCapacity?: number } = {},
  ) {
    const { db, offerings } = await import('@keki/database');
    const [offering] = await db
      .insert(offerings)
      .values({
        slug: `offering-${crypto.randomUUID()}`,
        name: `Test Class ${crypto.randomUUID()}`,
        type: 'CLASS',
        durationMinutes: overrides.durationMinutes ?? 60,
        defaultCapacity: overrides.defaultCapacity ?? 10,
        priceCents: 2500,
        status: overrides.status ?? 'PUBLISHED',
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

  describe('scheduleOccurrence', () => {
    it('derives endsAt from the offering duration (test 1, SC-04)', async () => {
      const { scheduleOccurrence } = await import('./occurrences');

      const offering = await seedOffering({ durationMinutes: 90 });
      const actorCustomerId = await actor();
      const startsAt = inMinutes(new Date(), 60);

      const occurrence = await scheduleOccurrence({
        data: { offeringId: offering.id, startsAt, capacityOverride: null },
        actorCustomerId,
      });

      expect(occurrence.endsAt.getTime()).toBe(inMinutes(startsAt, 90).getTime());
    });

    it('rejects a supplied endsAt and inserts nothing (test 2)', async () => {
      const { scheduleOccurrence } = await import('./occurrences');
      const { db, occurrences } = await import('@keki/database');
      const { eq } = await import('drizzle-orm');

      const offering = await seedOffering();
      const actorCustomerId = await actor();
      const startsAt = inMinutes(new Date(), 60);
      const invalid = {
        offeringId: offering.id,
        startsAt,
        endsAt: inMinutes(startsAt, 60),
        capacityOverride: null,
      };

      await expect(scheduleOccurrence({ data: invalid, actorCustomerId })).rejects.toThrow();

      const rows = await db.select().from(occurrences).where(eq(occurrences.offeringId, offering.id));
      expect(rows).toHaveLength(0);
    });

    it('refuses an unpublished offering and inserts nothing (test 3)', async () => {
      const { scheduleOccurrence } = await import('./occurrences');
      const { OfferingNotPublishedError } = await import('./errors');
      const { db, occurrences } = await import('@keki/database');
      const { eq } = await import('drizzle-orm');

      const offering = await seedOffering({ status: 'DRAFT' });
      const actorCustomerId = await actor();

      await expect(
        scheduleOccurrence({
          data: { offeringId: offering.id, startsAt: inMinutes(new Date(), 60), capacityOverride: null },
          actorCustomerId,
        }),
      ).rejects.toBeInstanceOf(OfferingNotPublishedError);

      const rows = await db.select().from(occurrences).where(eq(occurrences.offeringId, offering.id));
      expect(rows).toHaveLength(0);
    });

    it('refuses a past start (test 4, SC-05)', async () => {
      const { scheduleOccurrence } = await import('./occurrences');
      const { OccurrenceInPastError } = await import('./errors');

      const offering = await seedOffering();
      const actorCustomerId = await actor();
      const now = new Date();

      await expect(
        scheduleOccurrence({
          data: { offeringId: offering.id, startsAt: inMinutes(now, -1), capacityOverride: null },
          actorCustomerId,
          now,
        }),
      ).rejects.toBeInstanceOf(OccurrenceInPastError);
    });

    it('accepts a start moments in the future (test 5)', async () => {
      const { scheduleOccurrence } = await import('./occurrences');

      const offering = await seedOffering();
      const actorCustomerId = await actor();
      const now = new Date();

      const occurrence = await scheduleOccurrence({
        data: { offeringId: offering.id, startsAt: inMinutes(now, 1), capacityOverride: null },
        actorCustomerId,
        now,
      });

      expect(occurrence.status).toBe('SCHEDULED');
    });

    it('refuses an exact overlap (test 6, SC-06)', async () => {
      const { scheduleOccurrence } = await import('./occurrences');
      const { OverlappingOccurrenceError } = await import('./errors');

      const offering = await seedOffering();
      const actorCustomerId = await actor();
      const startsAt = inMinutes(new Date(), 60);

      const first = await scheduleOccurrence({
        data: { offeringId: offering.id, startsAt, capacityOverride: null },
        actorCustomerId,
      });

      const attempt = scheduleOccurrence({
        data: { offeringId: offering.id, startsAt, capacityOverride: null },
        actorCustomerId,
      });

      await expect(attempt).rejects.toBeInstanceOf(OverlappingOccurrenceError);
      await expect(attempt).rejects.toMatchObject({ conflictingOccurrenceId: first.id });
    });

    it('refuses a partial overlap in both directions (test 7)', async () => {
      const { scheduleOccurrence } = await import('./occurrences');
      const { OverlappingOccurrenceError } = await import('./errors');

      const offering = await seedOffering({ durationMinutes: 60 });
      const actorCustomerId = await actor();
      const existingStart = inMinutes(new Date(), 60);

      await scheduleOccurrence({
        data: { offeringId: offering.id, startsAt: existingStart, capacityOverride: null },
        actorCustomerId,
      });

      // new-inside-existing: the new occurrence starts 30 minutes into the
      // existing one's span (and, since both share the offering's fixed
      // duration, ends after it).
      await expect(
        scheduleOccurrence({
          data: { offeringId: offering.id, startsAt: inMinutes(existingStart, 30), capacityOverride: null },
          actorCustomerId,
        }),
      ).rejects.toBeInstanceOf(OverlappingOccurrenceError);

      // existing-inside-new (the other direction): the new occurrence starts
      // 30 minutes *before* the existing one, so the existing occurrence's
      // start falls inside the new one's span.
      await expect(
        scheduleOccurrence({
          data: {
            offeringId: offering.id,
            startsAt: inMinutes(existingStart, -30),
            capacityOverride: null,
          },
          actorCustomerId,
        }),
      ).rejects.toBeInstanceOf(OverlappingOccurrenceError);
    });

    it('permits adjacent occurrences (test 8)', async () => {
      const { scheduleOccurrence } = await import('./occurrences');

      const offering = await seedOffering({ durationMinutes: 60 });
      const actorCustomerId = await actor();
      const firstStart = inMinutes(new Date(), 60);

      const first = await scheduleOccurrence({
        data: { offeringId: offering.id, startsAt: firstStart, capacityOverride: null },
        actorCustomerId,
      });

      const second = await scheduleOccurrence({
        data: { offeringId: offering.id, startsAt: first.endsAt, capacityOverride: null },
        actorCustomerId,
      });

      expect(second.status).toBe('SCHEDULED');
    });

    it('scopes overlap checks to the offering (test 9)', async () => {
      const { scheduleOccurrence } = await import('./occurrences');

      const offeringA = await seedOffering();
      const offeringB = await seedOffering();
      const actorCustomerId = await actor();
      const startsAt = inMinutes(new Date(), 60);

      const a = await scheduleOccurrence({
        data: { offeringId: offeringA.id, startsAt, capacityOverride: null },
        actorCustomerId,
      });
      const b = await scheduleOccurrence({
        data: { offeringId: offeringB.id, startsAt, capacityOverride: null },
        actorCustomerId,
      });

      expect(a.status).toBe('SCHEDULED');
      expect(b.status).toBe('SCHEDULED');
    });

    it('is not blocked by a cancelled occurrence at the same time (test 10)', async () => {
      const { scheduleOccurrence, cancelOccurrence } = await import('./occurrences');

      const offering = await seedOffering();
      const actorCustomerId = await actor();
      const startsAt = inMinutes(new Date(), 60);

      const first = await scheduleOccurrence({
        data: { offeringId: offering.id, startsAt, capacityOverride: null },
        actorCustomerId,
      });
      await cancelOccurrence({ occurrenceId: first.id, actorCustomerId });

      const second = await scheduleOccurrence({
        data: { offeringId: offering.id, startsAt, capacityOverride: null },
        actorCustomerId,
      });

      expect(second.status).toBe('SCHEDULED');
    });
  });

  describe('updateOccurrence', () => {
    it('recomputes endsAt when the start moves (test 11)', async () => {
      const { scheduleOccurrence, updateOccurrence } = await import('./occurrences');

      const offering = await seedOffering({ durationMinutes: 60 });
      const actorCustomerId = await actor();
      const startsAt = inMinutes(new Date(), 60);

      const created = await scheduleOccurrence({
        data: { offeringId: offering.id, startsAt, capacityOverride: null },
        actorCustomerId,
      });

      const movedStart = inMinutes(startsAt, 60);
      const { after } = await updateOccurrence({
        occurrenceId: created.id,
        data: { startsAt: movedStart },
        actorCustomerId,
      });

      expect(after.startsAt.getTime()).toBe(movedStart.getTime());
      expect(after.endsAt.getTime()).toBe(created.endsAt.getTime() + 60 * 60_000);
    });

    it('excludes itself from the overlap check (test 12)', async () => {
      const { scheduleOccurrence, updateOccurrence } = await import('./occurrences');

      const offering = await seedOffering();
      const actorCustomerId = await actor();
      const startsAt = inMinutes(new Date(), 60);

      const created = await scheduleOccurrence({
        data: { offeringId: offering.id, startsAt, capacityOverride: null },
        actorCustomerId,
      });

      const { after } = await updateOccurrence({
        occurrenceId: created.id,
        data: { capacityOverride: 3 },
        actorCustomerId,
      });

      expect(after.startsAt.getTime()).toBe(startsAt.getTime());
    });

    it('refuses a cancelled occurrence and leaves it unchanged (test 17)', async () => {
      const { scheduleOccurrence, cancelOccurrence, updateOccurrence } = await import('./occurrences');
      const { InvalidOccurrenceTransitionError } = await import('./errors');
      const { getOccurrenceById } = await import('./queries');

      const offering = await seedOffering();
      const actorCustomerId = await actor();
      const startsAt = inMinutes(new Date(), 60);

      const created = await scheduleOccurrence({
        data: { offeringId: offering.id, startsAt, capacityOverride: null },
        actorCustomerId,
      });
      await cancelOccurrence({ occurrenceId: created.id, actorCustomerId });

      await expect(
        updateOccurrence({
          occurrenceId: created.id,
          data: { capacityOverride: 4 },
          actorCustomerId,
        }),
      ).rejects.toBeInstanceOf(InvalidOccurrenceTransitionError);

      const unchanged = await getOccurrenceById(created.id);
      expect(unchanged?.status).toBe('CANCELLED');
      expect(unchanged?.startsAt.getTime()).toBe(startsAt.getTime());
    });
  });

  describe('cancelOccurrence', () => {
    it('succeeds when unbooked (test 18, SC-09)', async () => {
      const { scheduleOccurrence, cancelOccurrence } = await import('./occurrences');

      const offering = await seedOffering();
      const actorCustomerId = await actor();

      const created = await scheduleOccurrence({
        data: { offeringId: offering.id, startsAt: inMinutes(new Date(), 60), capacityOverride: null },
        actorCustomerId,
      });

      const result = await cancelOccurrence({ occurrenceId: created.id, actorCustomerId });

      expect(result.changed).toBe(true);
      expect(result.occurrence.status).toBe('CANCELLED');
    });

    it('refuses confirmed reservations, carrying the count (test 19, SC-09)', async () => {
      const { scheduleOccurrence, cancelOccurrence } = await import('./occurrences');
      const { OccurrenceHasReservationsError } = await import('./errors');

      const offering = await seedOffering({ defaultCapacity: 10 });
      const actorCustomerId = await actor();
      const { household, customer } = await seedHouseholdAndCustomer();

      const created = await scheduleOccurrence({
        data: { offeringId: offering.id, startsAt: inMinutes(new Date(), 60), capacityOverride: null },
        actorCustomerId,
      });
      await seedReservation(created.id, household.id, customer.id, 'CONFIRMED');
      await seedReservation(created.id, household.id, customer.id, 'CONFIRMED');

      const attempt = cancelOccurrence({ occurrenceId: created.id, actorCustomerId });
      await expect(attempt).rejects.toBeInstanceOf(OccurrenceHasReservationsError);
      await expect(attempt).rejects.toMatchObject({ confirmedCount: 2 });

      const { getOccurrenceById } = await import('./queries');
      const unchanged = await getOccurrenceById(created.id);
      expect(unchanged?.status).toBe('SCHEDULED');
    });

    it('is not blocked by a held reservation (test 20)', async () => {
      const { scheduleOccurrence, cancelOccurrence } = await import('./occurrences');

      const offering = await seedOffering({ defaultCapacity: 10 });
      const actorCustomerId = await actor();
      const { household, customer } = await seedHouseholdAndCustomer();

      const created = await scheduleOccurrence({
        data: { offeringId: offering.id, startsAt: inMinutes(new Date(), 60), capacityOverride: null },
        actorCustomerId,
      });
      await seedReservation(created.id, household.id, customer.id, 'HELD');

      const result = await cancelOccurrence({ occurrenceId: created.id, actorCustomerId });
      expect(result.changed).toBe(true);
    });

    it('is not blocked by a cancelled reservation (test 21)', async () => {
      const { scheduleOccurrence, cancelOccurrence } = await import('./occurrences');

      const offering = await seedOffering({ defaultCapacity: 10 });
      const actorCustomerId = await actor();
      const { household, customer } = await seedHouseholdAndCustomer();

      const created = await scheduleOccurrence({
        data: { offeringId: offering.id, startsAt: inMinutes(new Date(), 60), capacityOverride: null },
        actorCustomerId,
      });
      await seedReservation(created.id, household.id, customer.id, 'CANCELLED');

      const result = await cancelOccurrence({ occurrenceId: created.id, actorCustomerId });
      expect(result.changed).toBe(true);
    });

    it('is idempotent (test 22)', async () => {
      const { scheduleOccurrence, cancelOccurrence } = await import('./occurrences');

      const offering = await seedOffering();
      const actorCustomerId = await actor();

      const created = await scheduleOccurrence({
        data: { offeringId: offering.id, startsAt: inMinutes(new Date(), 60), capacityOverride: null },
        actorCustomerId,
      });

      const first = await cancelOccurrence({ occurrenceId: created.id, actorCustomerId });
      const second = await cancelOccurrence({ occurrenceId: created.id, actorCustomerId });

      expect(first.changed).toBe(true);
      expect(second.changed).toBe(false);
    });

    it('disappears from /book once cancelled (test 23)', async () => {
      const { scheduleOccurrence, cancelOccurrence } = await import('./occurrences');
      const { listBookableOfferings } = await import('@keki/catalog-core');

      const offering = await seedOffering();
      const actorCustomerId = await actor();

      const created = await scheduleOccurrence({
        data: { offeringId: offering.id, startsAt: inMinutes(new Date(), 60), capacityOverride: null },
        actorCustomerId,
      });

      const before = await listBookableOfferings();
      expect(before.some((row) => row.occurrenceId === created.id)).toBe(true);

      await cancelOccurrence({ occurrenceId: created.id, actorCustomerId });

      const after = await listBookableOfferings();
      expect(after.some((row) => row.occurrenceId === created.id)).toBe(false);
    });
  });

  describe('listUpcomingOccurrences', () => {
    it('includes occurrences of unpublished offerings (test 24)', async () => {
      const { scheduleOccurrence } = await import('./occurrences');
      const { transitionOffering } = await import('./offerings');
      const { listUpcomingOccurrences } = await import('./queries');
      const { listBookableOfferings } = await import('@keki/catalog-core');

      const offering = await seedOffering();
      const actorCustomerId = await actor();
      const startsAt = inMinutes(new Date(), 60);

      const created = await scheduleOccurrence({
        data: { offeringId: offering.id, startsAt, capacityOverride: null },
        actorCustomerId,
      });
      await transitionOffering({ offeringId: created.offeringId, to: 'DRAFT', actorCustomerId });

      const bookable = await listBookableOfferings();
      expect(bookable.some((row) => row.occurrenceId === created.id)).toBe(false);

      const upcoming = await listUpcomingOccurrences({ from: inMinutes(startsAt, -1) });
      expect(upcoming.some((row) => row.occurrenceId === created.id)).toBe(true);
    });

    it('runs as a single query regardless of occurrence count (test 25)', async () => {
      const { db, occurrences } = await import('@keki/database');
      const { listUpcomingOccurrences } = await import('./queries');

      // Seeded directly rather than through scheduleOccurrence: this test
      // exercises listUpcomingOccurrences' query shape, not the write path,
      // and a raw insert avoids 20 sequential transactional round trips.
      const offering = await seedOffering({ durationMinutes: 1 });
      const from = inMinutes(new Date(), 60);

      for (let i = 0; i < 20; i += 1) {
        const startsAt = inMinutes(from, i * 5);
        await db.insert(occurrences).values({
          offeringId: offering.id,
          startsAt,
          endsAt: inMinutes(startsAt, 1),
          status: 'SCHEDULED',
        });
      }

      // `db` (queries.ts) is a neon-http client: one logical query is
      // exactly one HTTP round trip. Spying on the platform fetch counts
      // real round trips against the live branch, so an N+1 regression
      // fails this even if the query-building code still calls `.select()`
      // exactly once.
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      try {
        const result = await listUpcomingOccurrences({ from: inMinutes(from, -1) });
        expect(result.length).toBeGreaterThanOrEqual(20);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });
});
