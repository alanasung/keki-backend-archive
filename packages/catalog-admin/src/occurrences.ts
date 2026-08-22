import { and, eq, gt, inArray, lt, ne, sql } from 'drizzle-orm';
import { occurrences, offerings, reservations, withTransaction, type Tx } from '@keki/database';
import {
  createOccurrenceId,
  createOfferingId,
  scheduleOccurrenceSchema,
  SEAT_CONSUMING_STATUSES,
  updateOccurrenceSchema,
  type CustomerId,
  type Occurrence,
  type OccurrenceId,
  type OfferingId,
  type ScheduleOccurrenceInput,
  type UpdateOccurrenceInput,
} from '@keki/contracts';
import {
  InvalidOccurrenceTransitionError,
  OccurrenceHasReservationsError,
  OccurrenceInPastError,
  OccurrenceNotFoundError,
  OfferingNotFoundError,
  OfferingNotPublishedError,
  OverlappingOccurrenceError,
} from './errors';
import { toOccurrence } from './queries';
import { changedFields, recordAuditEntry } from './audit';

// SEAT_CONSUMING_STATUSES comes from @keki/contracts — one authority for the
// set, shared with the capacity trigger, catalog-core, and reservation-core.

// Confirmed seats block cancellation because refunds do not exist —
// `PAID` is terminal in the order state machine — so cancelling a class
// people paid for would leave money owed with no tracked path. A HELD seat
// does not block: a hold is an in-progress checkout that expires on its own
// within fifteen minutes.
const CANCELLATION_BLOCKING_STATUSES = ['CONFIRMED', 'CHECKED_IN'] as const;

async function findOverlap(
  tx: Tx,
  params: { offeringId: OfferingId; startsAt: Date; endsAt: Date; excludeOccurrenceId?: OccurrenceId },
) {
  const rows = await tx
    .select()
    .from(occurrences)
    .where(
      and(
        eq(occurrences.offeringId, params.offeringId),
        ne(occurrences.status, 'CANCELLED'),
        lt(occurrences.startsAt, params.endsAt),
        gt(occurrences.endsAt, params.startsAt),
        ...(params.excludeOccurrenceId !== undefined
          ? [ne(occurrences.id, params.excludeOccurrenceId)]
          : []),
      ),
    )
    .limit(1);
  return rows[0];
}

async function getBookedSeats(tx: Tx, occurrenceId: OccurrenceId): Promise<number> {
  const rows = await tx
    .select({
      bookedSeats: sql<number>`coalesce(sum(${reservations.seatCount}), 0)::int`,
    })
    .from(reservations)
    .where(
      and(eq(reservations.occurrenceId, occurrenceId), inArray(reservations.status, SEAT_CONSUMING_STATUSES)),
    );
  return rows[0]?.bookedSeats ?? 0;
}

export async function scheduleOccurrence(input: {
  data: ScheduleOccurrenceInput;
  actorCustomerId: CustomerId;
  now?: Date;
  tx?: Tx;
}): Promise<Occurrence> {
  // Parsed here even though every caller today already validated: this
  // persists catalog state and is reachable from more than one caller
  // (WS-04's Server Action today, others later).
  const data = scheduleOccurrenceSchema.parse(input.data);
  const now = input.now ?? new Date();

  const run = async (tx: Tx): Promise<Occurrence> => {
    const offeringId = createOfferingId(data.offeringId);

    const offeringRows = await tx.select().from(offerings).where(eq(offerings.id, offeringId)).limit(1);
    const offeringRow = offeringRows[0];
    if (offeringRow === undefined) {
      throw new OfferingNotFoundError(offeringId);
    }
    // Scheduling a draft is refused because the occurrence would be
    // invisible: listBookableOfferings filters to published offerings, so a
    // manager would see nothing on /book and reasonably conclude scheduling
    // failed. Refusing with a reason is kinder than succeeding invisibly.
    if (offeringRow.status !== 'PUBLISHED') {
      throw new OfferingNotPublishedError(offeringId, offeringRow.status);
    }

    // Same reasoning as above: /book filters to future occurrences, so a
    // past one is created and then invisible.
    if (data.startsAt.getTime() <= now.getTime()) {
      throw new OccurrenceInPastError(data.startsAt, now);
    }

    // Never accepted as input — two sources for the same span drift.
    const endsAt = new Date(data.startsAt.getTime() + offeringRow.durationMinutes * 60_000);

    // Scoped to the offering, not globally: two *different* classes may
    // legitimately run at once in different rooms.
    const conflict = await findOverlap(tx, { offeringId, startsAt: data.startsAt, endsAt });
    if (conflict !== undefined) {
      throw new OverlappingOccurrenceError(createOccurrenceId(conflict.id), conflict.startsAt);
    }

    const [row] = await tx
      .insert(occurrences)
      .values({
        offeringId,
        startsAt: data.startsAt,
        endsAt,
        capacityOverride: data.capacityOverride,
        status: 'SCHEDULED',
      })
      .returning();

    if (row === undefined) {
      throw new Error('scheduleOccurrence: insert into occurrences returned no row.');
    }

    await recordAuditEntry({
      executor: tx,
      actorCustomerId: input.actorCustomerId,
      action: 'occurrence.scheduled',
      entityType: 'occurrence',
      entityId: row.id,
      before: null,
      after: {
        offeringId: row.offeringId,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        capacityOverride: row.capacityOverride,
        status: row.status,
      },
    });

    return toOccurrence(row);
  };

  return input.tx !== undefined ? run(input.tx) : withTransaction(run);
}

export async function updateOccurrence(input: {
  occurrenceId: OccurrenceId;
  data: UpdateOccurrenceInput;
  actorCustomerId: CustomerId;
  now?: Date;
  tx?: Tx;
}): Promise<{ before: Occurrence; after: Occurrence; bookedSeats: number }> {
  const data = updateOccurrenceSchema.parse(input.data);
  const now = input.now ?? new Date();

  const run = async (tx: Tx): Promise<{ before: Occurrence; after: Occurrence; bookedSeats: number }> => {
    const beforeRows = await tx.select().from(occurrences).where(eq(occurrences.id, input.occurrenceId)).limit(1);
    const beforeRow = beforeRows[0];
    if (beforeRow === undefined) {
      throw new OccurrenceNotFoundError(input.occurrenceId);
    }
    if (beforeRow.status === 'CANCELLED') {
      throw new InvalidOccurrenceTransitionError(input.occurrenceId, 'CANCELLED', 'CANCELLED');
    }

    let startsAt = beforeRow.startsAt;
    let endsAt = beforeRow.endsAt;

    // Recompute endsAt whenever startsAt changes, from the offering's
    // current duration; re-apply the past-date and overlap checks, excluding
    // this row from the overlap query — otherwise every occurrence conflicts
    // with itself.
    if (data.startsAt !== undefined) {
      startsAt = data.startsAt;

      if (startsAt.getTime() <= now.getTime()) {
        throw new OccurrenceInPastError(startsAt, now);
      }

      const offeringId = createOfferingId(beforeRow.offeringId);
      const offeringRows = await tx.select().from(offerings).where(eq(offerings.id, offeringId)).limit(1);
      const offeringRow = offeringRows[0];
      if (offeringRow === undefined) {
        throw new OfferingNotFoundError(offeringId);
      }
      endsAt = new Date(startsAt.getTime() + offeringRow.durationMinutes * 60_000);

      const conflict = await findOverlap(tx, {
        offeringId,
        startsAt,
        endsAt,
        excludeOccurrenceId: input.occurrenceId,
      });
      if (conflict !== undefined) {
        throw new OverlappingOccurrenceError(createOccurrenceId(conflict.id), conflict.startsAt);
      }
    }

    // Permits lowering capacityOverride below the booked count — the
    // constraint is physical (a room got smaller), and refusing would leave
    // staff unable to record reality. The customer surface stays safe
    // because seatsRemaining clamps at zero.
    const updatedRows = await tx
      .update(occurrences)
      .set({
        startsAt,
        endsAt,
        ...(data.capacityOverride !== undefined ? { capacityOverride: data.capacityOverride } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(occurrences.id, input.occurrenceId), ne(occurrences.status, 'CANCELLED')))
      .returning();

    const updatedRow = updatedRows[0];
    if (updatedRow === undefined) {
      // A concurrent cancelOccurrence moved the status between the read
      // above and this statement.
      throw new InvalidOccurrenceTransitionError(input.occurrenceId, 'CANCELLED', 'CANCELLED');
    }

    // The same status set the capacity trigger counts and catalog-core
    // subtracts — if these three ever disagree, one surface advertises seats
    // another refuses.
    const bookedSeats = await getBookedSeats(tx, input.occurrenceId);

    // An edit that changed nothing is not an event.
    const diff = changedFields(beforeRow, updatedRow);
    if (Object.keys(diff.after).length > 0) {
      await recordAuditEntry({
        executor: tx,
        actorCustomerId: input.actorCustomerId,
        action: 'occurrence.updated',
        entityType: 'occurrence',
        entityId: input.occurrenceId,
        before: diff.before,
        after: diff.after,
      });
    }

    return { before: toOccurrence(beforeRow), after: toOccurrence(updatedRow), bookedSeats };
  };

  return input.tx !== undefined ? run(input.tx) : withTransaction(run);
}

export async function cancelOccurrence(input: {
  occurrenceId: OccurrenceId;
  actorCustomerId: CustomerId;
  tx?: Tx;
}): Promise<{ occurrence: Occurrence; changed: boolean }> {
  const run = async (tx: Tx): Promise<{ occurrence: Occurrence; changed: boolean }> => {
    const blockingRows = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(reservations)
      .where(
        and(
          eq(reservations.occurrenceId, input.occurrenceId),
          inArray(reservations.status, CANCELLATION_BLOCKING_STATUSES),
        ),
      );
    const confirmedCount = blockingRows[0]?.count ?? 0;
    if (confirmedCount > 0) {
      throw new OccurrenceHasReservationsError(input.occurrenceId, confirmedCount);
    }

    // Single conditional UPDATE guarded on the status just checked — never
    // read-then-write.
    const updatedRows = await tx
      .update(occurrences)
      .set({ status: 'CANCELLED', updatedAt: new Date() })
      .where(and(eq(occurrences.id, input.occurrenceId), eq(occurrences.status, 'SCHEDULED')))
      .returning();

    const updatedRow = updatedRows[0];
    if (updatedRow !== undefined) {
      await recordAuditEntry({
        executor: tx,
        actorCustomerId: input.actorCustomerId,
        action: 'occurrence.cancelled',
        entityType: 'occurrence',
        entityId: input.occurrenceId,
        before: { status: 'SCHEDULED' },
        after: { status: 'CANCELLED' },
      });
      return { occurrence: toOccurrence(updatedRow), changed: true };
    }

    // Nothing matched the guarded UPDATE: either it's already cancelled
    // (idempotent repeat) or it never existed.
    const currentRows = await tx.select().from(occurrences).where(eq(occurrences.id, input.occurrenceId)).limit(1);
    const current = currentRows[0];
    if (current === undefined) {
      throw new OccurrenceNotFoundError(input.occurrenceId);
    }
    return { occurrence: toOccurrence(current), changed: false };
  };

  return input.tx !== undefined ? run(input.tx) : withTransaction(run);
}
