import { and, eq, notInArray } from 'drizzle-orm';
import { db, reservationParticipants, reservations, withTransaction, type Tx } from '@keki/database';
import { createOccurrenceId } from '@keki/contracts';
import type {
  CartParticipantRef,
  CustomerId,
  HouseholdId,
  OccurrenceId,
  Reservation,
  ReservationId,
  TransactionScope,
} from '@keki/contracts';
import {
  CapacityExceededError,
  EmptyParticipantsError,
  InvalidReservationTransitionError,
  ReservationNotFoundError,
} from './errors';
import { getReservationById, toReservation, type ReservationRow } from './queries';

const DEFAULT_HOLD_TTL_MINUTES = 15;

// Stable SQLSTATE the WS-02 trigger raises (drizzle/0002_capacity_constraint.sql)
// rather than a message string, so this never breaks if the message wording
// changes. Works against both drivers this package touches — neon-http's
// `NeonDbError` and node-postgres's `DatabaseError` (used by the Pool-backed
// transaction in @keki/database's `withTransaction`) both surface the
// SQLSTATE as `.code`.
const CAPACITY_EXCEEDED_SQLSTATE = 'KEKI1';

function isCapacityExceededError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === CAPACITY_EXCEEDED_SQLSTATE
  );
}

interface InsertHoldInput {
  occurrenceId: OccurrenceId;
  householdId: HouseholdId;
  createdByCustomerId: CustomerId;
  participants: readonly CartParticipantRef[];
  holdExpiresAt: Date;
}

// The only place `reservations` and `reservation_participants` rows are
// inserted for a hold. Both the caller-supplied-`tx` path and the
// open-our-own-transaction path in `holdReservation` funnel through this one
// function so there is exactly one insert sequence to keep correct under
// concurrency, not two that can quietly drift apart.
async function insertHold(executor: Tx, input: InsertHoldInput): Promise<Reservation> {
  try {
    const [reservationRow] = await executor
      .insert(reservations)
      .values({
        occurrenceId: input.occurrenceId,
        householdId: input.householdId,
        createdByCustomerId: input.createdByCustomerId,
        status: 'HELD',
        seatCount: input.participants.length,
        holdExpiresAt: input.holdExpiresAt,
      })
      .returning();

    if (reservationRow === undefined) {
      throw new Error('holdReservation: insert into reservations returned no row.');
    }

    // Do not count seats before this point. Any read taken before the
    // reservations insert above can be invalidated by a concurrent
    // transaction before that insert lands — a classic
    // time-of-check-to-time-of-use bug. The WS-02 trigger's row lock
    // (drizzle/0002_capacity_constraint.sql), held only by the statement
    // performing the insert, is the only thing that makes this decision
    // safe, which is why the insert above is attempted first and this
    // function never issues a SELECT to pre-check capacity.
    await executor.insert(reservationParticipants).values(
      input.participants.map((participant) =>
        participant.kind === 'CUSTOMER'
          ? { reservationId: reservationRow.id, customerId: participant.customerId }
          : { reservationId: reservationRow.id, childId: participant.childId },
      ),
    );

    return toReservation(reservationRow);
  } catch (error) {
    if (isCapacityExceededError(error)) {
      throw new CapacityExceededError(input.occurrenceId, input.participants.length);
    }
    throw error;
  }
}

export async function holdReservation(input: {
  occurrenceId: OccurrenceId;
  householdId: HouseholdId;
  createdByCustomerId: CustomerId;
  participants: readonly CartParticipantRef[];
  holdTtlMinutes?: number;
  tx?: TransactionScope;
  now?: Date;
}): Promise<Reservation> {
  // Rejected before any statement is issued — a zero-seat hold consumes
  // nothing and would corrupt every downstream count.
  if (input.participants.length === 0) {
    throw new EmptyParticipantsError();
  }

  const now = input.now ?? new Date();
  const holdTtlMinutes = input.holdTtlMinutes ?? DEFAULT_HOLD_TTL_MINUTES;
  const holdExpiresAt = new Date(now.getTime() + holdTtlMinutes * 60_000);

  const insertInput: InsertHoldInput = {
    occurrenceId: input.occurrenceId,
    householdId: input.householdId,
    createdByCustomerId: input.createdByCustomerId,
    participants: input.participants,
    holdExpiresAt,
  };

  // When `tx` is supplied, every statement runs on that same handle — this
  // is what lets WS-05 compose order creation and seat holding atomically.
  // Otherwise this function is the transaction boundary: it opens one so the
  // reservation and its participant rows land, or neither does.
  if (input.tx !== undefined) {
    return insertHold(input.tx as Tx, insertInput);
  }
  return withTransaction((tx) => insertHold(tx, insertInput));
}

export async function confirmReservation(input: {
  reservationId: ReservationId;
  now?: Date;
}): Promise<{ reservation: Reservation; changed: boolean }> {
  const now = input.now ?? new Date();

  let updatedRows: ReservationRow[];
  try {
    updatedRows = await db
      .update(reservations)
      .set({ status: 'CONFIRMED', holdExpiresAt: null, updatedAt: now })
      .where(and(eq(reservations.id, input.reservationId), eq(reservations.status, 'HELD')))
      .returning();
  } catch (error) {
    // CONFIRMED consumes a seat exactly like HELD, so this UPDATE fires the
    // same trigger. It cannot double-count this row against itself (the
    // trigger excludes NEW.id), but the occurrence's effective capacity can
    // shrink between hold and confirm (a staff-side capacity_override
    // change), so the exceedance is real, not a false positive.
    if (isCapacityExceededError(error)) {
      const rows = await db
        .select({ occurrenceId: reservations.occurrenceId, seatCount: reservations.seatCount })
        .from(reservations)
        .where(eq(reservations.id, input.reservationId))
        .limit(1);
      const row = rows[0];
      if (row === undefined) {
        throw new ReservationNotFoundError(input.reservationId);
      }
      throw new CapacityExceededError(createOccurrenceId(row.occurrenceId), row.seatCount);
    }
    throw error;
  }

  const updatedRow = updatedRows[0];
  if (updatedRow !== undefined) {
    return { reservation: toReservation(updatedRow), changed: true };
  }

  // Nothing matched the guarded UPDATE — find out why, so a not-found
  // reservation, an already-confirmed one, and an invalid transition each
  // report distinctly rather than all looking like a silent no-op.
  const existing = await getReservationById(input.reservationId);
  if (existing === null) {
    throw new ReservationNotFoundError(input.reservationId);
  }
  // WS-10 retries this from an SQS-redelivered webhook — a second call
  // after the first already confirmed must be a no-op, not an error.
  if (existing.status === 'CONFIRMED') {
    return { reservation: existing, changed: false };
  }
  // If the expiry sweep already cancelled this hold, the seat may have been
  // resold. Silently re-confirming it here would hand out a seat that is
  // gone; WS-10 treats this as needing staff follow-up instead.
  throw new InvalidReservationTransitionError(input.reservationId, existing.status, 'CONFIRMED');
}

const CANCEL_TERMINAL_STATUSES: ('CANCELLED' | 'NO_SHOW')[] = ['CANCELLED', 'NO_SHOW'];

export async function cancelReservation(input: {
  reservationId: ReservationId;
  reason: string;
  now?: Date;
}): Promise<{ reservation: Reservation; changed: boolean }> {
  const now = input.now ?? new Date();

  // CANCELLED never trips the capacity trigger (it returns immediately for
  // any status outside HELD/CONFIRMED/CHECKED_IN), so unlike confirm above
  // there is no capacity-exceeded case to translate here: cancelling always
  // frees the seat, with no compensating bookkeeping.
  const updatedRows = await db
    .update(reservations)
    .set({ status: 'CANCELLED', notes: input.reason, holdExpiresAt: null, updatedAt: now })
    .where(and(eq(reservations.id, input.reservationId), notInArray(reservations.status, CANCEL_TERMINAL_STATUSES)))
    .returning();

  const updatedRow = updatedRows[0];
  if (updatedRow !== undefined) {
    return { reservation: toReservation(updatedRow), changed: true };
  }

  const existing = await getReservationById(input.reservationId);
  if (existing === null) {
    throw new ReservationNotFoundError(input.reservationId);
  }
  if (existing.status === 'CANCELLED') {
    return { reservation: existing, changed: false };
  }
  throw new InvalidReservationTransitionError(input.reservationId, existing.status, 'CANCELLED');
}
