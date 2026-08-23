import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { reservationParticipants, reservations, recordAuditEntry, withTransaction, type Tx } from '@keki/database';
import {
  canTransitionReservation,
  createReservationId,
  createReservationParticipantId,
  RESERVATION_STATUSES,
  type CustomerId,
  type ReservationId,
  type ReservationParticipantId,
  type ReservationStatus,
} from '@keki/contracts';
import {
  InvalidReservationTransitionError,
  ReservationNotCheckInEligibleError,
  ReservationNotFoundError,
  ReservationParticipantNotFoundError,
} from './errors';

// A HELD reservation is an unfinished checkout, not an attendee — check-in
// must go through CONFIRMED. CHECKED_IN is included so a second participant
// on an already-checked-in booking can still be checked in without a second
// reservation transition.
const CHECK_IN_ELIGIBLE_STATUSES: readonly ReservationStatus[] = ['CONFIRMED', 'CHECKED_IN'];

const NO_SHOW_ELIGIBLE_STATUSES = RESERVATION_STATUSES.filter((status) =>
  canTransitionReservation(status, 'NO_SHOW'),
);

interface ParticipantWithReservation {
  participantId: string;
  checkedInAt: Date | null;
  reservationId: string;
  reservationStatus: ReservationStatus;
}

async function loadParticipantWithReservation(
  tx: Tx,
  reservationParticipantId: ReservationParticipantId,
): Promise<ParticipantWithReservation | undefined> {
  const rows = await tx
    .select({
      participantId: reservationParticipants.id,
      checkedInAt: reservationParticipants.checkedInAt,
      reservationId: reservations.id,
      reservationStatus: reservations.status,
    })
    .from(reservationParticipants)
    .innerJoin(reservations, eq(reservationParticipants.reservationId, reservations.id))
    .where(eq(reservationParticipants.id, reservationParticipantId))
    .limit(1);
  return rows[0];
}

export async function checkInParticipant(input: {
  reservationParticipantId: ReservationParticipantId;
  actorCustomerId: CustomerId;
  now?: Date;
  tx?: Tx;
}): Promise<{
  participantId: ReservationParticipantId;
  reservationId: ReservationId;
  checkedInAt: Date;
  reservationStatus: ReservationStatus;
  changed: boolean;
}> {
  const now = input.now ?? new Date();

  const run = async (tx: Tx) => {
    const row = await loadParticipantWithReservation(tx, input.reservationParticipantId);
    if (row === undefined) {
      throw new ReservationParticipantNotFoundError(input.reservationParticipantId);
    }

    // A double-tap on a busy morning is the expected case, not an error:
    // return the original timestamp instead of restamping, and write no
    // audit row for a no-op.
    if (row.checkedInAt !== null) {
      return {
        participantId: createReservationParticipantId(row.participantId),
        reservationId: createReservationId(row.reservationId),
        checkedInAt: row.checkedInAt,
        reservationStatus: row.reservationStatus,
        changed: false,
      };
    }

    if (!CHECK_IN_ELIGIBLE_STATUSES.includes(row.reservationStatus)) {
      throw new ReservationNotCheckInEligibleError(createReservationId(row.reservationId), row.reservationStatus);
    }

    // Guarded on checked_in_at IS NULL: the barrier against two concurrent
    // transactions that both passed the check above racing to restamp. The
    // loser's UPDATE matches no row and falls back to the idempotent read
    // below instead of overwriting the winner's timestamp.
    const updatedRows = await tx
      .update(reservationParticipants)
      .set({ checkedInAt: now })
      .where(
        and(eq(reservationParticipants.id, row.participantId), isNull(reservationParticipants.checkedInAt)),
      )
      .returning();

    if (updatedRows[0] === undefined) {
      const existing = await loadParticipantWithReservation(tx, input.reservationParticipantId);
      if (existing === undefined || existing.checkedInAt === null) {
        throw new Error('checkInParticipant: lost the race but the participant is still not checked in.');
      }
      return {
        participantId: createReservationParticipantId(existing.participantId),
        reservationId: createReservationId(existing.reservationId),
        checkedInAt: existing.checkedInAt,
        reservationStatus: existing.reservationStatus,
        changed: false,
      };
    }

    // Roll the reservation status up. If it's already CHECKED_IN (a second
    // participant on the same booking), leave it — that is not a second
    // transition.
    let reservationStatus = row.reservationStatus;
    if (row.reservationStatus === 'CONFIRMED' && canTransitionReservation('CONFIRMED', 'CHECKED_IN')) {
      await tx
        .update(reservations)
        .set({ status: 'CHECKED_IN', updatedAt: now })
        .where(and(eq(reservations.id, row.reservationId), eq(reservations.status, 'CONFIRMED')));
      reservationStatus = 'CHECKED_IN';
    }

    // `reservationStatus` (before) vs the local `reservationStatus` variable
    // (after) lets a reader distinguish the check-in that actually rolled
    // the reservation up from one that landed on an already-CHECKED_IN
    // booking (a second participant on the same reservation).
    await recordAuditEntry({
      executor: tx,
      actorCustomerId: input.actorCustomerId,
      action: 'reservation.checked_in',
      entityType: 'reservation',
      entityId: row.reservationId,
      before: { reservationStatus: row.reservationStatus },
      after: { reservationParticipantId: row.participantId, checkedInAt: now, reservationStatus },
    });

    return {
      participantId: createReservationParticipantId(row.participantId),
      reservationId: createReservationId(row.reservationId),
      checkedInAt: now,
      reservationStatus,
      changed: true,
    };
  };

  return input.tx !== undefined ? run(input.tx) : withTransaction(run);
}

export async function undoCheckInParticipant(input: {
  reservationParticipantId: ReservationParticipantId;
  actorCustomerId: CustomerId;
  now?: Date;
  tx?: Tx;
}): Promise<{
  reservationId: ReservationId;
  reservationStatus: ReservationStatus;
  changed: boolean;
}> {
  const now = input.now ?? new Date();

  const run = async (tx: Tx) => {
    const row = await loadParticipantWithReservation(tx, input.reservationParticipantId);
    if (row === undefined) {
      throw new ReservationParticipantNotFoundError(input.reservationParticipantId);
    }

    // Idempotent in both directions: an already-undone check-in writes no
    // audit row either.
    if (row.checkedInAt === null) {
      return {
        reservationId: createReservationId(row.reservationId),
        reservationStatus: row.reservationStatus,
        changed: false,
      };
    }

    const clearedRows = await tx
      .update(reservationParticipants)
      .set({ checkedInAt: null })
      .where(
        and(eq(reservationParticipants.id, row.participantId), isNotNull(reservationParticipants.checkedInAt)),
      )
      .returning();

    if (clearedRows[0] === undefined) {
      // A concurrent undo already cleared it.
      return {
        reservationId: createReservationId(row.reservationId),
        reservationStatus: row.reservationStatus,
        changed: false,
      };
    }

    // Counted after the clear, inside this same transaction. Counting
    // before the clear, or outside the transaction, is the bug this step
    // exists to prevent — both produce a status that disagrees with the
    // rows beneath it.
    const remainingRows = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(reservationParticipants)
      .where(
        and(
          eq(reservationParticipants.reservationId, row.reservationId),
          isNotNull(reservationParticipants.checkedInAt),
        ),
      );
    const remaining = remainingRows[0]?.count ?? 0;

    let reservationStatus = row.reservationStatus;
    if (remaining === 0 && canTransitionReservation(row.reservationStatus, 'CONFIRMED')) {
      await tx
        .update(reservations)
        .set({ status: 'CONFIRMED', updatedAt: now })
        .where(and(eq(reservations.id, row.reservationId), eq(reservations.status, 'CHECKED_IN')));
      reservationStatus = 'CONFIRMED';
    }

    await recordAuditEntry({
      executor: tx,
      actorCustomerId: input.actorCustomerId,
      action: 'reservation.check_in_undone',
      entityType: 'reservation',
      entityId: row.reservationId,
      before: { reservationParticipantId: row.participantId, checkedInAt: row.checkedInAt },
      after: { reservationParticipantId: row.participantId, checkedInAt: null },
    });

    return {
      reservationId: createReservationId(row.reservationId),
      reservationStatus,
      changed: true,
    };
  };

  return input.tx !== undefined ? run(input.tx) : withTransaction(run);
}

// This is the one transition that releases a seat, since NO_SHOW is not
// seat-consuming (see drizzle/0002_capacity_constraint.sql). That is
// deliberate; there is no compensating hold.
export async function markReservationNoShow(input: {
  reservationId: ReservationId;
  actorCustomerId: CustomerId;
  tx?: Tx;
}): Promise<{ reservationId: ReservationId; changed: boolean }> {
  const run = async (tx: Tx) => {
    // Single conditional UPDATE guarded on the statuses the transition table
    // permits (only CONFIRMED, in practice) — never read-then-write.
    const updatedRows = await tx
      .update(reservations)
      .set({ status: 'NO_SHOW', updatedAt: new Date() })
      .where(
        and(
          eq(reservations.id, input.reservationId),
          sql`${reservations.status} in ${NO_SHOW_ELIGIBLE_STATUSES}`,
        ),
      )
      .returning();

    const updatedRow = updatedRows[0];
    if (updatedRow !== undefined) {
      await recordAuditEntry({
        executor: tx,
        actorCustomerId: input.actorCustomerId,
        action: 'reservation.no_show',
        entityType: 'reservation',
        entityId: input.reservationId,
        // NO_SHOW_ELIGIBLE_STATUSES is derived from RESERVATION_TRANSITIONS
        // and today contains only CONFIRMED, which is what the guarded
        // UPDATE above just moved out of.
        before: { status: 'CONFIRMED' },
        after: { status: 'NO_SHOW' },
      });
      return { reservationId: input.reservationId, changed: true };
    }

    // Nothing matched the guarded UPDATE: not found, already NO_SHOW
    // (idempotent), or an invalid transition (e.g. CHECKED_IN — someone
    // arrived; they are not a no-show).
    const currentRows = await tx.select().from(reservations).where(eq(reservations.id, input.reservationId)).limit(1);
    const current = currentRows[0];
    if (current === undefined) {
      throw new ReservationNotFoundError(input.reservationId);
    }
    if (current.status === 'NO_SHOW') {
      return { reservationId: input.reservationId, changed: false };
    }
    throw new InvalidReservationTransitionError(input.reservationId, current.status, 'NO_SHOW');
  };

  return input.tx !== undefined ? run(input.tx) : withTransaction(run);
}
