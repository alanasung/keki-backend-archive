import { and, eq, ne } from 'drizzle-orm';
import { offerings, withTransaction, type Tx } from '@keki/database';
import {
  canTransitionOffering,
  createOfferingSchema,
  updateOfferingSchema,
  type AuditAction,
  type CreateOfferingInput,
  type CustomerId,
  type Offering,
  type OfferingId,
  type OfferingStatus,
  type UpdateOfferingInput,
} from '@keki/contracts';
import { InvalidOfferingTransitionError, OfferingNotFoundError, UnsupportedOfferingTypeError } from './errors';
import { generateUniqueSlug } from './slug';
import { toOffering } from './queries';
import { changedFields, recordAuditEntry } from './audit';

// PUBLISHED and DRAFT get distinct actions (published/unpublished) rather
// than a generic update: "who took this off sale" is precisely the question
// staff_audit_log answers. ARCHIVED has no "un-" counterpart since
// OFFERING_TRANSITIONS makes it terminal.
function offeringTransitionAction(to: OfferingStatus): AuditAction {
  switch (to) {
    case 'PUBLISHED':
      return 'offering.published';
    case 'DRAFT':
      return 'offering.unpublished';
    case 'ARCHIVED':
      return 'offering.archived';
  }
}

export async function createOffering(input: {
  data: CreateOfferingInput;
  actorCustomerId: CustomerId;
  tx?: Tx;
}): Promise<Offering> {
  // Parsed here even though every caller today already validated: this
  // persists catalog state and is reachable from more than one caller
  // (WS-04's Server Action today, others later).
  const data = createOfferingSchema.parse(input.data);

  const run = async (tx: Tx): Promise<Offering> => {
    // Slug generation and the insert must share one executor — see slug.ts's
    // generateUniqueSlug for why a separate connection would race.
    const slug = await generateUniqueSlug(data.name, tx);

    const [row] = await tx
      .insert(offerings)
      .values({
        slug,
        name: data.name,
        description: data.description,
        type: data.type,
        durationMinutes: data.durationMinutes,
        defaultCapacity: data.defaultCapacity,
        priceCents: data.priceCents,
        currency: data.currency,
        // Always DRAFT, never a caller-supplied status (the schema disallows
        // one anyway) — creation and publication are separate acts.
        status: 'DRAFT',
      })
      .returning();

    if (row === undefined) {
      throw new Error('createOffering: insert into offerings returned no row.');
    }

    await recordAuditEntry({
      executor: tx,
      actorCustomerId: input.actorCustomerId,
      action: 'offering.created',
      entityType: 'offering',
      entityId: row.id,
      before: null,
      after: {
        name: row.name,
        description: row.description,
        type: row.type,
        durationMinutes: row.durationMinutes,
        defaultCapacity: row.defaultCapacity,
        priceCents: row.priceCents,
        currency: row.currency,
        status: row.status,
      },
    });

    return toOffering(row);
  };

  return input.tx !== undefined ? run(input.tx) : withTransaction(run);
}

export async function updateOffering(input: {
  offeringId: OfferingId;
  data: UpdateOfferingInput;
  actorCustomerId: CustomerId;
  tx?: Tx;
}): Promise<{ before: Offering; after: Offering }> {
  const data = updateOfferingSchema.parse(input.data);

  const run = async (tx: Tx): Promise<{ before: Offering; after: Offering }> => {
    const beforeRows = await tx.select().from(offerings).where(eq(offerings.id, input.offeringId)).limit(1);
    const beforeRow = beforeRows[0];
    if (beforeRow === undefined) {
      throw new OfferingNotFoundError(input.offeringId);
    }
    // Scope guard: catalog-admin manages CLASS offerings only (see the
    // package's Goal in the workstream spec); ROOM/OPEN_PLAY rows exist from
    // seeding and are out of scope for this write path.
    if (beforeRow.type !== 'CLASS') {
      throw new UnsupportedOfferingTypeError(beforeRow.type);
    }
    if (beforeRow.status === 'ARCHIVED') {
      throw new InvalidOfferingTransitionError(input.offeringId, 'ARCHIVED', 'ARCHIVED');
    }

    // Never touches `slug`, even when `name` changes: a slug that moves
    // breaks any link already shared, so renaming an offering is a display
    // change only.
    const updatedRows = await tx
      .update(offerings)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(offerings.id, input.offeringId), ne(offerings.status, 'ARCHIVED')))
      .returning();

    const updatedRow = updatedRows[0];
    if (updatedRow === undefined) {
      // The guarded UPDATE found nothing: a concurrent transitionOffering
      // archived this row between the read above and this statement.
      throw new InvalidOfferingTransitionError(input.offeringId, 'ARCHIVED', 'ARCHIVED');
    }

    // An edit that changed nothing is not an event.
    const diff = changedFields(beforeRow, updatedRow);
    if (Object.keys(diff.after).length > 0) {
      await recordAuditEntry({
        executor: tx,
        actorCustomerId: input.actorCustomerId,
        action: 'offering.updated',
        entityType: 'offering',
        entityId: input.offeringId,
        before: diff.before,
        after: diff.after,
      });
    }

    return { before: toOffering(beforeRow), after: toOffering(updatedRow) };
  };

  return input.tx !== undefined ? run(input.tx) : withTransaction(run);
}

export async function transitionOffering(input: {
  offeringId: OfferingId;
  to: OfferingStatus;
  actorCustomerId: CustomerId;
  tx?: Tx;
}): Promise<{ offering: Offering; changed: boolean }> {
  const run = async (tx: Tx): Promise<{ offering: Offering; changed: boolean }> => {
    const rows = await tx.select().from(offerings).where(eq(offerings.id, input.offeringId)).limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new OfferingNotFoundError(input.offeringId);
    }
    if (row.type !== 'CLASS') {
      throw new UnsupportedOfferingTypeError(row.type);
    }

    const from = row.status;

    // A double-clicked publish button must be harmless, not an error.
    if (from === input.to) {
      return { offering: toOffering(row), changed: false };
    }

    if (!canTransitionOffering(from, input.to)) {
      throw new InvalidOfferingTransitionError(input.offeringId, from, input.to);
    }

    // Single conditional UPDATE guarded on the status just read — never
    // read-then-write. Two managers publishing at once must not both
    // believe they made the change.
    const updatedRows = await tx
      .update(offerings)
      .set({ status: input.to, updatedAt: new Date() })
      .where(and(eq(offerings.id, input.offeringId), eq(offerings.status, from)))
      .returning();

    const updatedRow = updatedRows[0];
    if (updatedRow !== undefined) {
      // An idempotent repeat never reaches here (handled by the from === to
      // check above), so a real change happened and gets exactly one entry.
      await recordAuditEntry({
        executor: tx,
        actorCustomerId: input.actorCustomerId,
        action: offeringTransitionAction(input.to),
        entityType: 'offering',
        entityId: input.offeringId,
        before: { status: from },
        after: { status: input.to },
      });
      return { offering: toOffering(updatedRow), changed: true };
    }

    // Nothing matched the guarded UPDATE — a concurrent writer moved the
    // status between the read above and this statement. This diagnostic
    // re-read decides between an idempotent repeat and a genuinely illegal
    // edge; it never feeds back into what gets written.
    const currentRows = await tx.select().from(offerings).where(eq(offerings.id, input.offeringId)).limit(1);
    const current = currentRows[0];
    if (current === undefined) {
      throw new OfferingNotFoundError(input.offeringId);
    }
    if (current.status === input.to) {
      return { offering: toOffering(current), changed: false };
    }
    throw new InvalidOfferingTransitionError(input.offeringId, current.status, input.to);
  };

  return input.tx !== undefined ? run(input.tx) : withTransaction(run);
}
