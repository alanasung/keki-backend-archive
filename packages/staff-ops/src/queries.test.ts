import { describe, expect, it, vi } from 'vitest';
import { createOccurrenceId } from '@keki/contracts';
import { cafeDayBounds } from './day-boundaries';

const hasLiveDatabase =
  Boolean(process.env['DATABASE_URL_POOLED']) && Boolean(process.env['DATABASE_URL_DIRECT']);

function addMinutes(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * 60_000);
}

// Each occupancy test picks its own instant far in the future (plus a
// random spread) rather than sharing real "now". This suite isolates by
// per-test crypto.randomUUID()/instant rather than truncation (WS-04 spec),
// and getCurrentOccupancy's totals are global across the whole occurrences
// table — without a private "now" per test, one test's in-progress
// occurrence would leak into another's totalHeadcount assertion.
function farFutureNow(): Date {
  return new Date(Date.now() + 365 * 24 * 3600_000 + Math.floor(Math.random() * 10_000_000_000));
}

// Every function under test reads real occurrences, reservations,
// reservation_participants, customers, and children rows — the aggregate
// counts and join-based name resolution rely on real Postgres semantics no
// stub can faithfully imitate. Skipped when Neon credentials are unset
// (e.g. locally) and runs in CI once the branch is provisioned. Uses
// dynamic imports so a skipped run never triggers @keki/database's eager
// env validation at import time (see packages/notification-core/src/
// outbox.test.ts for the same pattern). cafeDayBounds has no such
// dependency, so it's imported statically above.
describe.skipIf(!hasLiveDatabase)('integration: staff-ops queries', () => {
  async function seedOffering(overrides: { defaultCapacity?: number } = {}) {
    const { db, offerings } = await import('@keki/database');
    const [offering] = await db
      .insert(offerings)
      .values({
        slug: `offering-${crypto.randomUUID()}`,
        name: `Test Class ${crypto.randomUUID()}`,
        type: 'CLASS',
        durationMinutes: 60,
        defaultCapacity: overrides.defaultCapacity ?? 10,
        priceCents: 2500,
        status: 'PUBLISHED',
      })
      .returning();
    return offering!;
  }

  async function seedOccurrence(
    offeringId: string,
    overrides: {
      startsAt?: Date;
      endsAt?: Date;
      status?: 'SCHEDULED' | 'CANCELLED' | 'COMPLETED';
      capacityOverride?: number | null;
    } = {},
  ) {
    const { db, occurrences } = await import('@keki/database');
    const startsAt = overrides.startsAt ?? addMinutes(new Date(), 60);
    const endsAt = overrides.endsAt ?? addMinutes(startsAt, 60);
    const [occurrence] = await db
      .insert(occurrences)
      .values({
        offeringId,
        startsAt,
        endsAt,
        status: overrides.status ?? 'SCHEDULED',
        capacityOverride: overrides.capacityOverride ?? null,
      })
      .returning();
    return occurrence!;
  }

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

  async function seedReservation(
    occurrenceId: string,
    householdId: string,
    createdByCustomerId: string,
    status: 'HELD' | 'CONFIRMED' | 'CHECKED_IN' | 'CANCELLED' | 'NO_SHOW',
    seatCount = 1,
  ) {
    const { db, reservations } = await import('@keki/database');
    const [reservation] = await db
      .insert(reservations)
      .values({ occurrenceId, householdId, createdByCustomerId, status, seatCount })
      .returning();
    return reservation!;
  }

  async function seedParticipant(
    reservationId: string,
    ref: { customerId: string } | { childId: string },
    checkedInAt: Date | null = null,
  ) {
    const { db, reservationParticipants } = await import('@keki/database');
    const [participant] = await db
      .insert(reservationParticipants)
      .values({ reservationId, ...ref, checkedInAt })
      .returning();
    return participant!;
  }

  describe('listTodaysOccurrences', () => {
    it("returns today's occurrences ascending (test 6, SC-01)", async () => {
      const { listTodaysOccurrences } = await import('./queries');
      const now = new Date();
      const { start } = cafeDayBounds(now);
      const offering = await seedOffering();

      const c = await seedOccurrence(offering.id, { startsAt: addMinutes(start, 180), endsAt: addMinutes(start, 210) });
      const a = await seedOccurrence(offering.id, { startsAt: addMinutes(start, 60), endsAt: addMinutes(start, 90) });
      const b = await seedOccurrence(offering.id, { startsAt: addMinutes(start, 120), endsAt: addMinutes(start, 150) });

      const rows = await listTodaysOccurrences({ now });
      const ids = new Set([a.id, b.id, c.id]);
      const ours = rows.filter((row) => ids.has(row.occurrenceId)).map((row) => row.occurrenceId);

      expect(ours).toEqual([a.id, b.id, c.id]);
    });

    it("excludes tomorrow's occurrences (test 7)", async () => {
      const { listTodaysOccurrences } = await import('./queries');
      const now = new Date();
      const { end } = cafeDayBounds(now);
      const offering = await seedOffering();
      const occurrence = await seedOccurrence(offering.id, {
        startsAt: addMinutes(end, 60),
        endsAt: addMinutes(end, 90),
      });

      const rows = await listTodaysOccurrences({ now });

      expect(rows.some((row) => row.occurrenceId === occurrence.id)).toBe(false);
    });

    it("excludes yesterday's occurrences (test 8)", async () => {
      const { listTodaysOccurrences } = await import('./queries');
      const now = new Date();
      const { start } = cafeDayBounds(now);
      const offering = await seedOffering();
      const occurrence = await seedOccurrence(offering.id, {
        startsAt: addMinutes(start, -60),
        endsAt: addMinutes(start, -30),
      });

      const rows = await listTodaysOccurrences({ now });

      expect(rows.some((row) => row.occurrenceId === occurrence.id)).toBe(false);
    });

    it('excludes CANCELLED occurrences (test 9)', async () => {
      const { listTodaysOccurrences } = await import('./queries');
      const now = new Date();
      const { start } = cafeDayBounds(now);
      const offering = await seedOffering();
      const occurrence = await seedOccurrence(offering.id, {
        startsAt: addMinutes(start, 60),
        endsAt: addMinutes(start, 90),
        status: 'CANCELLED',
      });

      const rows = await listTodaysOccurrences({ now });

      expect(rows.some((row) => row.occurrenceId === occurrence.id)).toBe(false);
    });

    it('expectedParticipants counts seat-consuming reservations only (test 10)', async () => {
      const { listTodaysOccurrences } = await import('./queries');
      const now = new Date();
      const { start } = cafeDayBounds(now);
      const offering = await seedOffering();
      const occurrence = await seedOccurrence(offering.id, {
        startsAt: addMinutes(start, 60),
        endsAt: addMinutes(start, 90),
      });

      const confirmedParty = await seedHouseholdAndCustomer();
      const confirmed = await seedReservation(occurrence.id, confirmedParty.household.id, confirmedParty.customer.id, 'CONFIRMED', 2);
      const confirmedChild = await seedChild(confirmedParty.household.id);
      await seedParticipant(confirmed.id, { customerId: confirmedParty.customer.id });
      await seedParticipant(confirmed.id, { childId: confirmedChild.id });

      const heldParty = await seedHouseholdAndCustomer();
      const held = await seedReservation(occurrence.id, heldParty.household.id, heldParty.customer.id, 'HELD', 1);
      await seedParticipant(held.id, { customerId: heldParty.customer.id });

      const cancelledParty = await seedHouseholdAndCustomer();
      const cancelled = await seedReservation(occurrence.id, cancelledParty.household.id, cancelledParty.customer.id, 'CANCELLED', 3);
      const cancelledChildA = await seedChild(cancelledParty.household.id);
      const cancelledChildB = await seedChild(cancelledParty.household.id);
      await seedParticipant(cancelled.id, { customerId: cancelledParty.customer.id });
      await seedParticipant(cancelled.id, { childId: cancelledChildA.id });
      await seedParticipant(cancelled.id, { childId: cancelledChildB.id });

      const rows = await listTodaysOccurrences({ now });
      const row = rows.find((r) => r.occurrenceId === occurrence.id);

      expect(row?.expectedParticipants).toBe(3);
    });

    it('arrivedParticipants counts only checked-in rows (test 11)', async () => {
      const { listTodaysOccurrences } = await import('./queries');
      const now = new Date();
      const { start } = cafeDayBounds(now);
      const offering = await seedOffering();
      const occurrence = await seedOccurrence(offering.id, {
        startsAt: addMinutes(start, 60),
        endsAt: addMinutes(start, 90),
      });
      const { household, customer } = await seedHouseholdAndCustomer();
      const reservation = await seedReservation(occurrence.id, household.id, customer.id, 'CONFIRMED', 3);
      const childA = await seedChild(household.id);
      const childB = await seedChild(household.id);
      await seedParticipant(reservation.id, { customerId: customer.id }, now);
      await seedParticipant(reservation.id, { childId: childA.id });
      await seedParticipant(reservation.id, { childId: childB.id });

      const rows = await listTodaysOccurrences({ now });
      const row = rows.find((r) => r.occurrenceId === occurrence.id);

      expect(row?.arrivedParticipants).toBe(1);
      expect(row?.expectedParticipants).toBe(3);
    });

    it('arrivedParticipants is zero before anyone arrives (test 12)', async () => {
      const { listTodaysOccurrences } = await import('./queries');
      const now = new Date();
      const { start } = cafeDayBounds(now);
      const offering = await seedOffering();
      const occurrence = await seedOccurrence(offering.id, {
        startsAt: addMinutes(start, 60),
        endsAt: addMinutes(start, 90),
      });
      const { household, customer } = await seedHouseholdAndCustomer();
      const reservation = await seedReservation(occurrence.id, household.id, customer.id, 'CONFIRMED', 2);
      const child = await seedChild(household.id);
      await seedParticipant(reservation.id, { customerId: customer.id });
      await seedParticipant(reservation.id, { childId: child.id });

      const rows = await listTodaysOccurrences({ now });
      const row = rows.find((r) => r.occurrenceId === occurrence.id);

      expect(row?.arrivedParticipants).toBe(0);
    });

    it('computes both counts from one query regardless of occurrence count (test 13)', async () => {
      const { listTodaysOccurrences } = await import('./queries');
      const { db, occurrences } = await import('@keki/database');
      const now = new Date();
      const { start } = cafeDayBounds(now);
      const offering = await seedOffering();

      const seededIds: string[] = [];
      for (let i = 0; i < 20; i += 1) {
        const startsAt = addMinutes(start, 60 + i * 5);
        const [row] = await db
          .insert(occurrences)
          .values({ offeringId: offering.id, startsAt, endsAt: addMinutes(startsAt, 1), status: 'SCHEDULED' })
          .returning();
        seededIds.push(row!.id);
      }

      // `db` is a neon-http client: one logical query is exactly one HTTP
      // round trip. Spying on fetch counts real round trips against the
      // live branch, catching an N+1 regression even if the query-building
      // code still calls `.select()` exactly once (mirrors catalog-admin's
      // listUpcomingOccurrences query-count test).
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      try {
        const rows = await listTodaysOccurrences({ now });
        expect(seededIds.every((id) => rows.some((row) => row.occurrenceId === id))).toBe(true);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  describe('listOccurrenceRoster', () => {
    it("resolves a child's name (test 14, SC-14)", async () => {
      const { listOccurrenceRoster } = await import('./queries');
      const offering = await seedOffering();
      const occurrence = await seedOccurrence(offering.id);
      const { household, customer } = await seedHouseholdAndCustomer();
      const reservation = await seedReservation(occurrence.id, household.id, customer.id, 'CONFIRMED');
      const child = await seedChild(household.id);
      const participant = await seedParticipant(reservation.id, { childId: child.id });

      const roster = await listOccurrenceRoster(createOccurrenceId(occurrence.id));
      const row = roster.find((r) => r.participantId === participant.id);

      expect(row?.displayName).toBe(`${child.firstName} ${child.lastName}`);
      expect(row?.isChild).toBe(true);
    });

    it("resolves an adult customer's name (test 15)", async () => {
      const { listOccurrenceRoster } = await import('./queries');
      const offering = await seedOffering();
      const occurrence = await seedOccurrence(offering.id);
      const { household, customer } = await seedHouseholdAndCustomer();
      const reservation = await seedReservation(occurrence.id, household.id, customer.id, 'CONFIRMED');
      const participant = await seedParticipant(reservation.id, { customerId: customer.id });

      const roster = await listOccurrenceRoster(createOccurrenceId(occurrence.id));
      const row = roster.find((r) => r.participantId === participant.id);

      expect(row?.displayName).toBe(`${customer.firstName} ${customer.lastName}`);
      expect(row?.isChild).toBe(false);
    });

    // Both customer_id and child_id are ON DELETE NO ACTION (drizzle/
    // 0000_even_blob.sql), so a genuinely orphaned reference can never arise
    // through the app or be constructed in a live-DB test without dropping
    // a shared foreign key on the integration branch — too destructive for
    // what this asserts. resolveParticipantDisplayName is the exact
    // fallback logic listOccurrenceRoster's row-mapping calls; testing it
    // directly here covers test 16 without touching the database.
    it("an unresolvable participant yields 'Unknown participant' and does not throw (test 16)", async () => {
      const { resolveParticipantDisplayName } = await import('./queries');

      const unresolvedChild = resolveParticipantDisplayName({
        childId: crypto.randomUUID(),
        customerFirstName: null,
        customerLastName: null,
        childFirstName: null,
        childLastName: null,
      });
      const unresolvedCustomer = resolveParticipantDisplayName({
        childId: null,
        customerFirstName: null,
        customerLastName: null,
        childFirstName: null,
        childLastName: null,
      });

      expect(unresolvedChild).toEqual({ displayName: 'Unknown participant', isChild: true });
      expect(unresolvedCustomer).toEqual({ displayName: 'Unknown participant', isChild: false });
    });

    it('orders un-arrived first (test 17)', async () => {
      const { listOccurrenceRoster } = await import('./queries');
      const offering = await seedOffering();
      const occurrence = await seedOccurrence(offering.id);
      const { household, customer } = await seedHouseholdAndCustomer();
      const reservation = await seedReservation(occurrence.id, household.id, customer.id, 'CONFIRMED', 3);
      const childA = await seedChild(household.id);
      const childB = await seedChild(household.id);
      const arrived = await seedParticipant(reservation.id, { customerId: customer.id }, new Date());
      const waitingA = await seedParticipant(reservation.id, { childId: childA.id });
      const waitingB = await seedParticipant(reservation.id, { childId: childB.id });

      const roster = await listOccurrenceRoster(createOccurrenceId(occurrence.id));
      const ids = new Set([arrived.id, waitingA.id, waitingB.id]);
      const ours = roster.filter((r) => ids.has(r.participantId));

      expect(ours).toHaveLength(3);
      expect(ours[ours.length - 1]?.participantId).toBe(arrived.id);
      expect(ours.filter((r) => r.checkedInAt !== null)).toHaveLength(1);
    });

    it('excludes cancelled reservations (test 18)', async () => {
      const { listOccurrenceRoster } = await import('./queries');
      const offering = await seedOffering();
      const occurrence = await seedOccurrence(offering.id);
      const { household, customer } = await seedHouseholdAndCustomer();
      const reservation = await seedReservation(occurrence.id, household.id, customer.id, 'CANCELLED');
      const participant = await seedParticipant(reservation.id, { customerId: customer.id });

      const roster = await listOccurrenceRoster(createOccurrenceId(occurrence.id));

      expect(roster.some((r) => r.participantId === participant.id)).toBe(false);
    });

    it('carries checkedInAt and reservation status per row (test 19)', async () => {
      const { listOccurrenceRoster } = await import('./queries');
      const offering = await seedOffering();
      const occurrence = await seedOccurrence(offering.id);
      const { household, customer } = await seedHouseholdAndCustomer();
      const reservation = await seedReservation(occurrence.id, household.id, customer.id, 'CONFIRMED');
      const now = new Date();
      const participant = await seedParticipant(reservation.id, { customerId: customer.id }, now);

      const roster = await listOccurrenceRoster(createOccurrenceId(occurrence.id));
      const row = roster.find((r) => r.participantId === participant.id);

      expect(row?.checkedInAt?.getTime()).toBe(now.getTime());
      expect(row?.reservationStatus).toBe('CONFIRMED');
    });
  });

  describe('getCurrentOccupancy', () => {
    it('counts checked-in participants of in-progress occurrences (test 20, SC-15)', async () => {
      const { getCurrentOccupancy } = await import('./queries');
      const now = farFutureNow();
      const offering = await seedOffering();
      const occurrence = await seedOccurrence(offering.id, {
        startsAt: addMinutes(now, -10),
        endsAt: addMinutes(now, 50),
      });
      const { household, customer } = await seedHouseholdAndCustomer();
      const reservation = await seedReservation(occurrence.id, household.id, customer.id, 'CONFIRMED', 3);
      const childA = await seedChild(household.id);
      const childB = await seedChild(household.id);
      await seedParticipant(reservation.id, { customerId: customer.id }, now);
      await seedParticipant(reservation.id, { childId: childA.id }, now);
      await seedParticipant(reservation.id, { childId: childB.id });

      const snapshot = await getCurrentOccupancy({ now });

      expect(snapshot.totalHeadcount).toBe(2);
    });

    it('excludes an occurrence that has ended (test 21)', async () => {
      const { getCurrentOccupancy } = await import('./queries');
      const now = farFutureNow();
      const offering = await seedOffering();
      const occurrence = await seedOccurrence(offering.id, {
        startsAt: addMinutes(now, -70),
        endsAt: addMinutes(now, -10),
      });
      const { household, customer } = await seedHouseholdAndCustomer();
      const reservation = await seedReservation(occurrence.id, household.id, customer.id, 'CONFIRMED');
      await seedParticipant(reservation.id, { customerId: customer.id }, now);

      const snapshot = await getCurrentOccupancy({ now });

      expect(snapshot.totalHeadcount).toBe(0);
    });

    it('excludes an occurrence that has not started (test 22)', async () => {
      const { getCurrentOccupancy } = await import('./queries');
      const now = farFutureNow();
      const offering = await seedOffering();
      const occurrence = await seedOccurrence(offering.id, {
        startsAt: addMinutes(now, 10),
        endsAt: addMinutes(now, 70),
      });
      const { household, customer } = await seedHouseholdAndCustomer();
      const reservation = await seedReservation(occurrence.id, household.id, customer.id, 'CONFIRMED');
      await seedParticipant(reservation.id, { customerId: customer.id }, now);

      const snapshot = await getCurrentOccupancy({ now });

      expect(snapshot.totalHeadcount).toBe(0);
    });

    it('excludes participants who are not checked in (test 23)', async () => {
      const { getCurrentOccupancy } = await import('./queries');
      const now = farFutureNow();
      const offering = await seedOffering();
      const occurrence = await seedOccurrence(offering.id, {
        startsAt: addMinutes(now, -10),
        endsAt: addMinutes(now, 50),
      });
      const { household, customer } = await seedHouseholdAndCustomer();
      const reservation = await seedReservation(occurrence.id, household.id, customer.id, 'CONFIRMED', 3);
      const childA = await seedChild(household.id);
      const childB = await seedChild(household.id);
      await seedParticipant(reservation.id, { customerId: customer.id });
      await seedParticipant(reservation.id, { childId: childA.id });
      await seedParticipant(reservation.id, { childId: childB.id });

      const snapshot = await getCurrentOccupancy({ now });

      expect(snapshot.totalHeadcount).toBe(0);
    });

    it('reports per-occurrence lines that sum to the total (test 24)', async () => {
      const { getCurrentOccupancy } = await import('./queries');
      const now = farFutureNow();
      const offering = await seedOffering();
      const occurrenceA = await seedOccurrence(offering.id, {
        startsAt: addMinutes(now, -10),
        endsAt: addMinutes(now, 50),
      });
      const occurrenceB = await seedOccurrence(offering.id, {
        startsAt: addMinutes(now, -20),
        endsAt: addMinutes(now, 40),
      });

      const partyA = await seedHouseholdAndCustomer();
      const reservationA = await seedReservation(occurrenceA.id, partyA.household.id, partyA.customer.id, 'CONFIRMED');
      await seedParticipant(reservationA.id, { customerId: partyA.customer.id }, now);

      const partyB = await seedHouseholdAndCustomer();
      const reservationB = await seedReservation(occurrenceB.id, partyB.household.id, partyB.customer.id, 'CONFIRMED', 2);
      const childB = await seedChild(partyB.household.id);
      await seedParticipant(reservationB.id, { customerId: partyB.customer.id }, now);
      await seedParticipant(reservationB.id, { childId: childB.id }, now);

      const snapshot = await getCurrentOccupancy({ now });
      const lineA = snapshot.lines.find((l) => l.occurrenceId === occurrenceA.id);
      const lineB = snapshot.lines.find((l) => l.occurrenceId === occurrenceB.id);

      expect(lineA?.headcount).toBe(1);
      expect(lineB?.headcount).toBe(2);
      expect(snapshot.totalHeadcount).toBe(3);
    });

    it('asOf reflects the supplied now (test 25)', async () => {
      const { getCurrentOccupancy } = await import('./queries');
      const now = farFutureNow();

      const snapshot = await getCurrentOccupancy({ now });

      expect(snapshot.asOf.getTime()).toBe(now.getTime());
    });

    it('an empty building returns zero and no lines (test 26)', async () => {
      const { getCurrentOccupancy } = await import('./queries');
      const now = farFutureNow();

      const snapshot = await getCurrentOccupancy({ now });

      expect(snapshot.totalHeadcount).toBe(0);
      expect(snapshot.lines).toEqual([]);
    });
  });
});
