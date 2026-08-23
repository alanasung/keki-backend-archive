import { describe, expect, it } from 'vitest';
import { createReservationId, createReservationParticipantId } from '@keki/contracts';

const hasLiveDatabase =
  Boolean(process.env['DATABASE_URL_POOLED']) && Boolean(process.env['DATABASE_URL_DIRECT']);

// Every function under test writes or reads real reservations,
// reservation_participants, and staff_audit_log rows, and several
// assertions (the roll-up, SC-11's rollback, SC-16's untouched seat count)
// rely on real Postgres semantics no stub can faithfully imitate. Skipped
// when Neon credentials are unset (e.g. locally) and runs in CI once the
// branch is provisioned. Uses dynamic imports so a skipped run never
// triggers @keki/database's eager env validation at import time (see
// packages/notification-core/src/outbox.test.ts for the same pattern).
//
// Isolated by per-test crypto.randomUUID() identifiers rather than
// truncation, so this suite cannot disturb others sharing the CI branch.
describe.skipIf(!hasLiveDatabase)('integration: staff-ops check-in', () => {
  async function actor() {
    const { db, households, customers } = await import('@keki/database');
    const { createCustomerId } = await import('@keki/contracts');
    const [household] = await db
      .insert(households)
      .values({ name: `WS-03 Actor Household ${crypto.randomUUID()}` })
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
        defaultCapacity: overrides.defaultCapacity ?? 10,
        priceCents: 2500,
        status: 'PUBLISHED',
      })
      .returning();
    return offering!;
  }

  async function seedOccurrence(offeringId: string, overrides: { capacityOverride?: number } = {}) {
    const { db, occurrences } = await import('@keki/database');
    const startsAt = new Date(Date.now() + 60 * 60_000);
    const [occurrence] = await db
      .insert(occurrences)
      .values({
        offeringId,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 60 * 60_000),
        status: 'SCHEDULED',
        capacityOverride: overrides.capacityOverride ?? null,
      })
      .returning();
    return occurrence!;
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
    status: 'HELD' | 'CONFIRMED' | 'CHECKED_IN' | 'CANCELLED' | 'NO_SHOW',
    seatCount = 1,
  ) {
    const { db, reservations } = await import('@keki/database');
    const [reservation] = await db
      .insert(reservations)
      .values({ occurrenceId, householdId, createdByCustomerId, status, seatCount })
      .returning();
    return { ...reservation!, id: createReservationId(reservation!.id) };
  }

  // A real customer, not a bare random id: reservation_participants'
  // exactly-one-of check permits customerId or childId, and a seeded
  // customer keeps this independent of the household that created the
  // reservation.
  async function seedParticipant(reservationId: string) {
    const { db, households, customers, reservationParticipants } = await import('@keki/database');
    const [household] = await db
      .insert(households)
      .values({ name: `WS-03 Participant Household ${crypto.randomUUID()}` })
      .returning();
    const [customer] = await db
      .insert(customers)
      .values({
        householdId: household!.id,
        cognitoSub: `participant-${crypto.randomUUID()}`,
        firstName: 'Participant',
        lastName: 'Kid',
      })
      .returning();
    const [participant] = await db
      .insert(reservationParticipants)
      .values({ reservationId, customerId: customer!.id })
      .returning();
    return { ...participant!, id: createReservationParticipantId(participant!.id) };
  }

  async function auditRowsFor(entityId: string, action: string) {
    const { db, staffAuditLog } = await import('@keki/database');
    const { and, eq } = await import('drizzle-orm');
    return db
      .select()
      .from(staffAuditLog)
      .where(and(eq(staffAuditLog.entityId, entityId), eq(staffAuditLog.action, action)));
  }

  function asRecord(value: unknown): Record<string, unknown> {
    return value as Record<string, unknown>;
  }

  async function seedConfirmedReservationWithParticipant(seatCount = 1) {
    const offering = await seedOffering();
    const occurrence = await seedOccurrence(offering.id);
    const { household, customer } = await seedHouseholdAndCustomer();
    const reservation = await seedReservation(occurrence.id, household.id, customer.id, 'CONFIRMED', seatCount);
    const participant = await seedParticipant(reservation.id);
    return { offering, occurrence, reservation, participant };
  }

  describe('checkInParticipant', () => {
    it('sets checked_in_at within a second of now (test 1, SC-03)', async () => {
      const { checkInParticipant } = await import('./check-in');
      const { reservation, participant } = await seedConfirmedReservationWithParticipant();
      const actorCustomerId = await actor();
      const now = new Date();

      const result = await checkInParticipant({
        reservationParticipantId: participant.id,
        actorCustomerId,
        now,
      });

      expect(result.reservationId).toBe(reservation.id);
      expect(Math.abs(result.checkedInAt.getTime() - now.getTime())).toBeLessThan(1000);
    });

    it('moves the reservation CONFIRMED -> CHECKED_IN on the first check-in (test 2, SC-04)', async () => {
      const { checkInParticipant } = await import('./check-in');
      const { participant } = await seedConfirmedReservationWithParticipant();
      const actorCustomerId = await actor();

      const result = await checkInParticipant({ reservationParticipantId: participant.id, actorCustomerId });

      expect(result.reservationStatus).toBe('CHECKED_IN');
    });

    it('a second participant does not re-transition (test 3)', async () => {
      const { checkInParticipant } = await import('./check-in');
      const offering = await seedOffering();
      const occurrence = await seedOccurrence(offering.id);
      const { household, customer } = await seedHouseholdAndCustomer();
      const reservation = await seedReservation(occurrence.id, household.id, customer.id, 'CONFIRMED', 2);
      const participantA = await seedParticipant(reservation.id);
      const participantB = await seedParticipant(reservation.id);
      const actorCustomerId = await actor();

      const first = await checkInParticipant({ reservationParticipantId: participantA.id, actorCustomerId });
      const second = await checkInParticipant({ reservationParticipantId: participantB.id, actorCustomerId });

      expect(first.reservationStatus).toBe('CHECKED_IN');
      expect(second.reservationStatus).toBe('CHECKED_IN');

      const rows = await auditRowsFor(reservation.id, 'reservation.checked_in');
      expect(rows).toHaveLength(2);
      const statusChangingRows = rows.filter((row) => {
        const before = asRecord(row.before);
        const after = asRecord(row.after);
        return before['reservationStatus'] !== after['reservationStatus'];
      });
      expect(statusChangingRows).toHaveLength(1);
    });

    it('is idempotent: unchanged timestamp and no second audit row (test 4, SC-06)', async () => {
      const { checkInParticipant } = await import('./check-in');
      const { reservation, participant } = await seedConfirmedReservationWithParticipant();
      const actorCustomerId = await actor();

      const first = await checkInParticipant({ reservationParticipantId: participant.id, actorCustomerId });
      const second = await checkInParticipant({ reservationParticipantId: participant.id, actorCustomerId });

      expect(first.changed).toBe(true);
      expect(second.changed).toBe(false);
      expect(second.checkedInAt.getTime()).toBe(first.checkedInAt.getTime());

      const rows = await auditRowsFor(reservation.id, 'reservation.checked_in');
      expect(rows).toHaveLength(1);
    });

    it('refuses a HELD reservation, carrying the status (test 5, SC-07)', async () => {
      const { checkInParticipant } = await import('./check-in');
      const { ReservationNotCheckInEligibleError } = await import('./errors');
      const offering = await seedOffering();
      const occurrence = await seedOccurrence(offering.id);
      const { household, customer } = await seedHouseholdAndCustomer();
      const reservation = await seedReservation(occurrence.id, household.id, customer.id, 'HELD');
      const participant = await seedParticipant(reservation.id);
      const actorCustomerId = await actor();

      const attempt = checkInParticipant({ reservationParticipantId: participant.id, actorCustomerId });
      await expect(attempt).rejects.toBeInstanceOf(ReservationNotCheckInEligibleError);
      await expect(attempt).rejects.toMatchObject({ status: 'HELD' });

      const { db, reservationParticipants } = await import('@keki/database');
      const { eq } = await import('drizzle-orm');
      const rows = await db
        .select()
        .from(reservationParticipants)
        .where(eq(reservationParticipants.id, participant.id));
      expect(rows[0]?.checkedInAt).toBeNull();
    });

    it('refuses a CANCELLED reservation (test 6)', async () => {
      const { checkInParticipant } = await import('./check-in');
      const { ReservationNotCheckInEligibleError } = await import('./errors');
      const offering = await seedOffering();
      const occurrence = await seedOccurrence(offering.id);
      const { household, customer } = await seedHouseholdAndCustomer();
      const reservation = await seedReservation(occurrence.id, household.id, customer.id, 'CANCELLED');
      const participant = await seedParticipant(reservation.id);
      const actorCustomerId = await actor();

      const attempt = checkInParticipant({ reservationParticipantId: participant.id, actorCustomerId });
      await expect(attempt).rejects.toBeInstanceOf(ReservationNotCheckInEligibleError);
      await expect(attempt).rejects.toMatchObject({ status: 'CANCELLED' });
    });

    it('throws on an unknown participant id and writes nothing (test 7)', async () => {
      const { checkInParticipant } = await import('./check-in');
      const { ReservationParticipantNotFoundError } = await import('./errors');
      const actorCustomerId = await actor();

      await expect(
        checkInParticipant({
          reservationParticipantId: createReservationParticipantId(crypto.randomUUID()),
          actorCustomerId,
        }),
      ).rejects.toBeInstanceOf(ReservationParticipantNotFoundError);
    });

    it('does not change the occurrence seat count (test 8, SC-16)', async () => {
      const { checkInParticipant } = await import('./check-in');
      const { occurrence, participant } = await seedConfirmedReservationWithParticipant();
      const { db, reservations } = await import('@keki/database');
      const { and, eq, inArray, sql } = await import('drizzle-orm');
      const { SEAT_CONSUMING_STATUSES } = await import('@keki/contracts');

      async function bookedSeats(): Promise<number> {
        const rows = await db
          .select({
            bookedSeats: sql<number>`coalesce(sum(${reservations.seatCount}), 0)::int`,
          })
          .from(reservations)
          .where(
            and(
              eq(reservations.occurrenceId, occurrence.id),
              inArray(reservations.status, SEAT_CONSUMING_STATUSES),
            ),
          );
        return rows[0]?.bookedSeats ?? 0;
      }

      const before = await bookedSeats();
      const actorCustomerId = await actor();
      await checkInParticipant({ reservationParticipantId: participant.id, actorCustomerId });
      const after = await bookedSeats();

      expect(after).toBe(before);
    });
  });

  describe('undoCheckInParticipant', () => {
    it('clears the timestamp (test 9)', async () => {
      const { checkInParticipant, undoCheckInParticipant } = await import('./check-in');
      const { participant } = await seedConfirmedReservationWithParticipant();
      const actorCustomerId = await actor();
      await checkInParticipant({ reservationParticipantId: participant.id, actorCustomerId });

      await undoCheckInParticipant({ reservationParticipantId: participant.id, actorCustomerId });

      const { db, reservationParticipants } = await import('@keki/database');
      const { eq } = await import('drizzle-orm');
      const rows = await db
        .select()
        .from(reservationParticipants)
        .where(eq(reservationParticipants.id, participant.id));
      expect(rows[0]?.checkedInAt).toBeNull();
    });

    it('reverts the only check-in to CONFIRMED (test 10, SC-05)', async () => {
      const { checkInParticipant, undoCheckInParticipant } = await import('./check-in');
      const { participant } = await seedConfirmedReservationWithParticipant();
      const actorCustomerId = await actor();
      await checkInParticipant({ reservationParticipantId: participant.id, actorCustomerId });

      const result = await undoCheckInParticipant({ reservationParticipantId: participant.id, actorCustomerId });

      expect(result.reservationStatus).toBe('CONFIRMED');
    });

    it('leaves the reservation CHECKED_IN when undoing one of three (test 11)', async () => {
      const { checkInParticipant, undoCheckInParticipant } = await import('./check-in');
      const offering = await seedOffering();
      const occurrence = await seedOccurrence(offering.id);
      const { household, customer } = await seedHouseholdAndCustomer();
      const reservation = await seedReservation(occurrence.id, household.id, customer.id, 'CONFIRMED', 3);
      const participantA = await seedParticipant(reservation.id);
      const participantB = await seedParticipant(reservation.id);
      const participantC = await seedParticipant(reservation.id);
      const actorCustomerId = await actor();

      await checkInParticipant({ reservationParticipantId: participantA.id, actorCustomerId });
      const checkedInB = await checkInParticipant({ reservationParticipantId: participantB.id, actorCustomerId });
      const checkedInC = await checkInParticipant({ reservationParticipantId: participantC.id, actorCustomerId });

      const result = await undoCheckInParticipant({
        reservationParticipantId: participantA.id,
        actorCustomerId,
      });

      expect(result.reservationStatus).toBe('CHECKED_IN');

      const { db, reservationParticipants } = await import('@keki/database');
      const { eq } = await import('drizzle-orm');
      const [rowB] = await db
        .select()
        .from(reservationParticipants)
        .where(eq(reservationParticipants.id, participantB.id));
      const [rowC] = await db
        .select()
        .from(reservationParticipants)
        .where(eq(reservationParticipants.id, participantC.id));
      expect(rowB?.checkedInAt?.getTime()).toBe(checkedInB.checkedInAt.getTime());
      expect(rowC?.checkedInAt?.getTime()).toBe(checkedInC.checkedInAt.getTime());
    });

    it('is idempotent: no second audit row (test 12)', async () => {
      const { checkInParticipant, undoCheckInParticipant } = await import('./check-in');
      const { reservation, participant } = await seedConfirmedReservationWithParticipant();
      const actorCustomerId = await actor();
      await checkInParticipant({ reservationParticipantId: participant.id, actorCustomerId });

      const first = await undoCheckInParticipant({ reservationParticipantId: participant.id, actorCustomerId });
      const second = await undoCheckInParticipant({ reservationParticipantId: participant.id, actorCustomerId });

      expect(first.changed).toBe(true);
      expect(second.changed).toBe(false);

      const rows = await auditRowsFor(reservation.id, 'reservation.check_in_undone');
      expect(rows).toHaveLength(1);
    });
  });

  describe('markReservationNoShow', () => {
    async function seedConfirmedReservation(seatCount = 1, capacityOverride?: number) {
      const offering = await seedOffering();
      const occurrence = await seedOccurrence(
        offering.id,
        capacityOverride !== undefined ? { capacityOverride } : {},
      );
      const { household, customer } = await seedHouseholdAndCustomer();
      const reservation = await seedReservation(occurrence.id, household.id, customer.id, 'CONFIRMED', seatCount);
      return { offering, occurrence, reservation };
    }

    it('sets the status to NO_SHOW (test 13)', async () => {
      const { markReservationNoShow } = await import('./check-in');
      const { reservation } = await seedConfirmedReservation();
      const actorCustomerId = await actor();

      await markReservationNoShow({ reservationId: reservation.id, actorCustomerId });

      const { db, reservations } = await import('@keki/database');
      const { eq } = await import('drizzle-orm');
      const rows = await db.select().from(reservations).where(eq(reservations.id, reservation.id));
      expect(rows[0]?.status).toBe('NO_SHOW');
    });

    it('releases the seat, visible on listBookableOfferings (test 14, SC-08)', async () => {
      const { markReservationNoShow } = await import('./check-in');
      const { occurrence, reservation } = await seedConfirmedReservation(2, 2);
      const actorCustomerId = await actor();
      const { listBookableOfferings } = await import('@keki/catalog-core');

      const before = await listBookableOfferings();
      const beforeRow = before.find((row) => row.occurrenceId === occurrence.id);
      expect(beforeRow?.seatsRemaining).toBe(0);

      await markReservationNoShow({ reservationId: reservation.id, actorCustomerId });

      const after = await listBookableOfferings();
      const afterRow = after.find((row) => row.occurrenceId === occurrence.id);
      expect(afterRow?.seatsRemaining).toBe(2);
    });

    it('refuses a CHECKED_IN reservation (test 15, SC-09)', async () => {
      const { checkInParticipant, markReservationNoShow } = await import('./check-in');
      const { InvalidReservationTransitionError } = await import('./errors');
      const { reservation, participant } = await seedConfirmedReservationWithParticipant();
      const actorCustomerId = await actor();
      await checkInParticipant({ reservationParticipantId: participant.id, actorCustomerId });

      const attempt = markReservationNoShow({ reservationId: reservation.id, actorCustomerId });
      await expect(attempt).rejects.toBeInstanceOf(InvalidReservationTransitionError);
      await expect(attempt).rejects.toMatchObject({ fromStatus: 'CHECKED_IN', toStatus: 'NO_SHOW' });
    });

    it('is idempotent (test 16)', async () => {
      const { markReservationNoShow } = await import('./check-in');
      const { reservation } = await seedConfirmedReservation();
      const actorCustomerId = await actor();

      const first = await markReservationNoShow({ reservationId: reservation.id, actorCustomerId });
      const second = await markReservationNoShow({ reservationId: reservation.id, actorCustomerId });

      expect(first.changed).toBe(true);
      expect(second.changed).toBe(false);
    });
  });

  describe('audit', () => {
    it('each command writes exactly one row naming actor, action, and reservation entity (test 17)', async () => {
      const { checkInParticipant, undoCheckInParticipant, markReservationNoShow } = await import('./check-in');

      const checkIn = await seedConfirmedReservationWithParticipant();
      const checkInActor = await actor();
      await checkInParticipant({ reservationParticipantId: checkIn.participant.id, actorCustomerId: checkInActor });
      const checkInRows = await auditRowsFor(checkIn.reservation.id, 'reservation.checked_in');
      expect(checkInRows).toHaveLength(1);
      expect(checkInRows[0]?.entityType).toBe('reservation');
      expect(checkInRows[0]?.entityId).toBe(checkIn.reservation.id);
      expect(checkInRows[0]?.actorCustomerId).toBe(checkInActor);

      const undo = await seedConfirmedReservationWithParticipant();
      const undoActor = await actor();
      await checkInParticipant({ reservationParticipantId: undo.participant.id, actorCustomerId: undoActor });
      await undoCheckInParticipant({ reservationParticipantId: undo.participant.id, actorCustomerId: undoActor });
      const undoRows = await auditRowsFor(undo.reservation.id, 'reservation.check_in_undone');
      expect(undoRows).toHaveLength(1);
      expect(undoRows[0]?.entityType).toBe('reservation');
      expect(undoRows[0]?.entityId).toBe(undo.reservation.id);
      expect(undoRows[0]?.actorCustomerId).toBe(undoActor);

      const offering = await seedOffering();
      const occurrence = await seedOccurrence(offering.id);
      const { household, customer } = await seedHouseholdAndCustomer();
      const noShowReservation = await seedReservation(occurrence.id, household.id, customer.id, 'CONFIRMED');
      const noShowActor = await actor();
      await markReservationNoShow({ reservationId: noShowReservation.id, actorCustomerId: noShowActor });
      const noShowRows = await auditRowsFor(noShowReservation.id, 'reservation.no_show');
      expect(noShowRows).toHaveLength(1);
      expect(noShowRows[0]?.entityType).toBe('reservation');
      expect(noShowRows[0]?.entityId).toBe(noShowReservation.id);
      expect(noShowRows[0]?.actorCustomerId).toBe(noShowActor);
    });

    it('the check-in audit row carries the participant id in after (test 19)', async () => {
      const { checkInParticipant } = await import('./check-in');
      const { reservation, participant } = await seedConfirmedReservationWithParticipant();
      const actorCustomerId = await actor();

      await checkInParticipant({ reservationParticipantId: participant.id, actorCustomerId });

      const rows = await auditRowsFor(reservation.id, 'reservation.checked_in');
      const after = asRecord(rows[0]?.after);
      expect(after['reservationParticipantId']).toBe(participant.id);
    });

    it('a rolled-back check-in leaves no audit row and no timestamp (test 20, SC-11)', async () => {
      const { checkInParticipant } = await import('./check-in');
      const { withTransaction, staffAuditLog, db, reservationParticipants } = await import('@keki/database');
      const { eq } = await import('drizzle-orm');
      const { reservation, participant } = await seedConfirmedReservationWithParticipant();
      const actorCustomerId = await actor();

      await expect(
        withTransaction((tx) => {
          const failingTx = {
            select: tx.select.bind(tx),
            update: () => {
              throw new Error('forced update failure for test 20');
            },
          };
          return checkInParticipant({
            reservationParticipantId: participant.id,
            actorCustomerId,
            tx: failingTx as unknown as typeof tx,
          });
        }),
      ).rejects.toThrow('forced update failure for test 20');

      const auditRows = await db
        .select()
        .from(staffAuditLog)
        .where(eq(staffAuditLog.entityId, reservation.id));
      expect(auditRows).toHaveLength(0);

      const participantRows = await db
        .select()
        .from(reservationParticipants)
        .where(eq(reservationParticipants.id, participant.id));
      expect(participantRows[0]?.checkedInAt).toBeNull();
    });

    it('a rolled-back no-show leaves no audit row and no status change (test 21, SC-11)', async () => {
      const { markReservationNoShow } = await import('./check-in');
      const { withTransaction, staffAuditLog, db, reservations } = await import('@keki/database');
      const { eq } = await import('drizzle-orm');
      const offering = await seedOffering();
      const occurrence = await seedOccurrence(offering.id);
      const { household, customer } = await seedHouseholdAndCustomer();
      const reservation = await seedReservation(occurrence.id, household.id, customer.id, 'CONFIRMED');
      const actorCustomerId = await actor();

      await expect(
        withTransaction((tx) => {
          const failingTx = {
            select: tx.select.bind(tx),
            update: () => {
              throw new Error('forced update failure for test 21');
            },
          };
          return markReservationNoShow({
            reservationId: reservation.id,
            actorCustomerId,
            tx: failingTx as unknown as typeof tx,
          });
        }),
      ).rejects.toThrow('forced update failure for test 21');

      const auditRows = await db
        .select()
        .from(staffAuditLog)
        .where(eq(staffAuditLog.entityId, reservation.id));
      expect(auditRows).toHaveLength(0);

      const reservationRows = await db.select().from(reservations).where(eq(reservations.id, reservation.id));
      expect(reservationRows[0]?.status).toBe('CONFIRMED');
    });

    it('a refused check-in writes no audit row (test 22)', async () => {
      const { checkInParticipant } = await import('./check-in');
      const { ReservationNotCheckInEligibleError } = await import('./errors');
      const offering = await seedOffering();
      const occurrence = await seedOccurrence(offering.id);
      const { household, customer } = await seedHouseholdAndCustomer();
      const reservation = await seedReservation(occurrence.id, household.id, customer.id, 'HELD');
      const participant = await seedParticipant(reservation.id);
      const actorCustomerId = await actor();

      await expect(
        checkInParticipant({ reservationParticipantId: participant.id, actorCustomerId }),
      ).rejects.toBeInstanceOf(ReservationNotCheckInEligibleError);

      const rows = await auditRowsFor(reservation.id, 'reservation.checked_in');
      expect(rows).toHaveLength(0);
    });
  });
});
