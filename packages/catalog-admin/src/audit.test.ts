import { describe, expect, it } from 'vitest';
import type { CreateOfferingInput, CustomerId } from '@keki/contracts';

const hasLiveDatabase =
  Boolean(process.env['DATABASE_URL_POOLED']) && Boolean(process.env['DATABASE_URL_DIRECT']);

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

// No live database involved — a source scan, not a query — so this runs
// unconditionally rather than behind hasLiveDatabase, unlike every other
// suite in this file. Neither offerings.ts nor occurrences.ts imports
// @keki/database eagerly in a way that matters here since we never load
// them, only read their text.
describe('audit coverage', () => {
  it('every offering/occurrence AUDIT_ACTION is emitted by at least one command (test 18)', async () => {
    const { readFileSync } = await import('node:fs');
    const { AUDIT_ACTIONS } = await import('@keki/contracts');

    const offeringsSource = readFileSync(new URL('./offerings.ts', import.meta.url), 'utf-8');
    const occurrencesSource = readFileSync(new URL('./occurrences.ts', import.meta.url), 'utf-8');
    const combined = `${offeringsSource}\n${occurrencesSource}`;

    // Scoped to this package's own vocabulary: catalog-admin owns
    // offering.* and occurrence.* actions, but AUDIT_ACTIONS is a shared
    // closed set across every staff surface — WS-01 adds reservation.*
    // actions that a different package (reservation-core) emits, and this
    // check has no way to see that package's source.
    const catalogAdminActions = AUDIT_ACTIONS.filter(
      (action) => action.startsWith('offering.') || action.startsWith('occurrence.'),
    );

    for (const action of catalogAdminActions) {
      expect(combined).toContain(`'${action}'`);
    }
  });
});

// Every function under test writes or reads real staff_audit_log rows, and
// SC-11 (test 4, test 5) depends on a real Postgres ROLLBACK no stub can
// faithfully imitate. Skipped when Neon credentials are unset (e.g.
// locally) and runs in CI once the branch is provisioned. Uses dynamic
// imports so a skipped run never triggers @keki/database's eager env
// validation at import time (see packages/notification-core/src/outbox.test.ts
// for the same pattern) — audit.ts itself imports @keki/database eagerly for
// the staffAuditLog table, so even test 17's compile-only check has to live
// in here rather than beside test 18.
//
// Follows commerce-core's isolation approach — per-test crypto.randomUUID()
// identifiers rather than truncation — so this suite cannot disturb others
// sharing the CI branch.
describe.skipIf(!hasLiveDatabase)('integration: catalog-admin audit', () => {
  function validOfferingInput(overrides: Partial<CreateOfferingInput> = {}): CreateOfferingInput {
    return {
      name: `Test Class ${crypto.randomUUID()}`,
      description: 'A hands-on class.',
      type: 'CLASS',
      durationMinutes: 60,
      defaultCapacity: 10,
      priceCents: 2500,
      currency: 'USD',
      ...overrides,
    };
  }

  // A real customer, not a bare random id: staff_audit_log.actor_customer_id
  // is a genuine foreign key to customers, so an unbacked id would fail
  // every audit insert this suite exists to exercise.
  async function actor(): Promise<CustomerId> {
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

  async function seedPublishedOffering(actorCustomerId: CustomerId) {
    const { createOffering, transitionOffering } = await import('./offerings');
    const created = await createOffering({ data: validOfferingInput(), actorCustomerId });
    const { offering } = await transitionOffering({ offeringId: created.id, to: 'PUBLISHED', actorCustomerId });
    return offering;
  }

  async function seedConfirmedReservation(occurrenceId: string): Promise<void> {
    const { db, households, customers, reservations } = await import('@keki/database');
    const [household] = await db
      .insert(households)
      .values({ name: `WS-04 Booking Household ${crypto.randomUUID()}` })
      .returning();
    const [customer] = await db
      .insert(customers)
      .values({
        householdId: household!.id,
        cognitoSub: `booker-${crypto.randomUUID()}`,
        firstName: 'Book',
        lastName: 'Er',
      })
      .returning();
    await db.insert(reservations).values({
      occurrenceId,
      householdId: household!.id,
      createdByCustomerId: customer!.id,
      status: 'CONFIRMED',
      seatCount: 1,
    });
  }

  async function auditRowsFor(entityId: string, action: string) {
    const { db, staffAuditLog } = await import('@keki/database');
    const { and, eq } = await import('drizzle-orm');
    return db
      .select()
      .from(staffAuditLog)
      .where(and(eq(staffAuditLog.entityId, entityId), eq(staffAuditLog.action, action)));
  }

  function inMinutes(base: Date, minutes: number): Date {
    return new Date(base.getTime() + minutes * 60_000);
  }

  describe('createOffering', () => {
    it('writes exactly one staff_audit_log row (test 1, SC-10)', async () => {
      const { createOffering } = await import('./offerings');
      const actorCustomerId = await actor();

      const offering = await createOffering({ data: validOfferingInput(), actorCustomerId });

      const rows = await auditRowsFor(offering.id, 'offering.created');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.entityType).toBe('offering');
      expect(rows[0]?.entityId).toBe(offering.id);
    });

    it('names the actor (test 2)', async () => {
      const { createOffering } = await import('./offerings');
      const actorCustomerId = await actor();

      const offering = await createOffering({ data: validOfferingInput(), actorCustomerId });

      const rows = await auditRowsFor(offering.id, 'offering.created');
      expect(rows[0]?.actorCustomerId).toBe(actorCustomerId);
    });

    it('records the created values in after, with before null (test 3)', async () => {
      const { createOffering } = await import('./offerings');
      const actorCustomerId = await actor();
      const data = validOfferingInput({ priceCents: 3300 });

      const offering = await createOffering({ data, actorCustomerId });

      const rows = await auditRowsFor(offering.id, 'offering.created');
      expect(rows[0]?.before).toBeNull();
      const after = asRecord(rows[0]?.after);
      expect(after['name']).toBe(data.name);
      expect(after['priceCents']).toBe(3300);
    });

    it('a rolled-back create leaves no entry (test 4, SC-11)', async () => {
      const { createOffering } = await import('./offerings');
      const { withTransaction, db, offerings, staffAuditLog } = await import('@keki/database');
      const { eq, sql } = await import('drizzle-orm');

      const data = validOfferingInput();
      const actorCustomerId = await actor();

      // Same stub shape as offerings.test.ts's own atomicity test: a real
      // SELECT (so slug generation genuinely completes) with the INSERT
      // forced to throw, proving withTransaction rolls the real transaction
      // back rather than merely that the override never ran.
      await expect(
        withTransaction((tx) => {
          const failingTx = {
            select: tx.select.bind(tx),
            insert: () => {
              throw new Error('forced insert failure for test 4');
            },
          };
          return createOffering({ data, actorCustomerId, tx: failingTx as unknown as typeof tx });
        }),
      ).rejects.toThrow('forced insert failure for test 4');

      const offeringRows = await db.select().from(offerings).where(eq(offerings.name, data.name));
      expect(offeringRows).toHaveLength(0);

      // No offering id exists to scope by (the insert never landed), so this
      // scopes on the name captured in `after` instead — the same isolation
      // guarantee the other tests get from entityId.
      const auditRows = await db
        .select()
        .from(staffAuditLog)
        .where(sql`${staffAuditLog.after} ->> 'name' = ${data.name}`);
      expect(auditRows).toHaveLength(0);
    });
  });

  describe('updateOffering', () => {
    it('a rolled-back update leaves no entry (test 5, SC-11)', async () => {
      const { createOffering, updateOffering } = await import('./offerings');
      const { withTransaction, db, offerings } = await import('@keki/database');
      const { eq } = await import('drizzle-orm');

      const actorCustomerId = await actor();
      const created = await createOffering({ data: validOfferingInput({ priceCents: 1000 }), actorCustomerId });

      await expect(
        withTransaction((tx) => {
          const failingTx = {
            select: tx.select.bind(tx),
            update: () => {
              throw new Error('forced update failure for test 5');
            },
          };
          return updateOffering({
            offeringId: created.id,
            data: { priceCents: 2000 },
            actorCustomerId,
            tx: failingTx as unknown as typeof tx,
          });
        }),
      ).rejects.toThrow('forced update failure for test 5');

      const rows = await auditRowsFor(created.id, 'offering.updated');
      expect(rows).toHaveLength(0);

      const offeringRows = await db.select().from(offerings).where(eq(offerings.id, created.id));
      expect(offeringRows[0]?.priceCents).toBe(1000);
    });

    it('records only changed fields (test 6)', async () => {
      const { createOffering, updateOffering } = await import('./offerings');
      const actorCustomerId = await actor();

      const created = await createOffering({ data: validOfferingInput({ priceCents: 1000 }), actorCustomerId });
      await updateOffering({ offeringId: created.id, data: { priceCents: 2000 }, actorCustomerId });

      const rows = await auditRowsFor(created.id, 'offering.updated');
      expect(rows).toHaveLength(1);
      const before = asRecord(rows[0]?.before);
      const after = asRecord(rows[0]?.after);
      expect(after['priceCents']).toBe(2000);
      expect(before['priceCents']).toBe(1000);
      expect(after).not.toHaveProperty('name');
      expect(before).not.toHaveProperty('name');
    });

    it('excludes updatedAt from the diff (test 7)', async () => {
      const { createOffering, updateOffering } = await import('./offerings');
      const actorCustomerId = await actor();

      const created = await createOffering({ data: validOfferingInput({ priceCents: 1000 }), actorCustomerId });
      await updateOffering({ offeringId: created.id, data: { priceCents: 2000 }, actorCustomerId });

      const rows = await auditRowsFor(created.id, 'offering.updated');
      const before = asRecord(rows[0]?.before);
      const after = asRecord(rows[0]?.after);
      expect(before).not.toHaveProperty('updatedAt');
      expect(after).not.toHaveProperty('updatedAt');
    });

    it('a no-op update writes no entry (test 8)', async () => {
      const { createOffering, updateOffering } = await import('./offerings');
      const actorCustomerId = await actor();

      const created = await createOffering({ data: validOfferingInput({ priceCents: 1500 }), actorCustomerId });
      await updateOffering({ offeringId: created.id, data: { priceCents: 1500 }, actorCustomerId });

      const rows = await auditRowsFor(created.id, 'offering.updated');
      expect(rows).toHaveLength(0);
    });
  });

  describe('transitionOffering', () => {
    it('publishing writes offering.published (test 9)', async () => {
      const { createOffering, transitionOffering } = await import('./offerings');
      const actorCustomerId = await actor();

      const created = await createOffering({ data: validOfferingInput(), actorCustomerId });
      await transitionOffering({ offeringId: created.id, to: 'PUBLISHED', actorCustomerId });

      const rows = await auditRowsFor(created.id, 'offering.published');
      expect(rows).toHaveLength(1);
    });

    it('unpublishing writes offering.unpublished (test 10)', async () => {
      const { createOffering, transitionOffering } = await import('./offerings');
      const actorCustomerId = await actor();

      const created = await createOffering({ data: validOfferingInput(), actorCustomerId });
      await transitionOffering({ offeringId: created.id, to: 'PUBLISHED', actorCustomerId });
      await transitionOffering({ offeringId: created.id, to: 'DRAFT', actorCustomerId });

      const rows = await auditRowsFor(created.id, 'offering.unpublished');
      expect(rows).toHaveLength(1);
    });

    it('archiving writes offering.archived (test 11)', async () => {
      const { createOffering, transitionOffering } = await import('./offerings');
      const actorCustomerId = await actor();

      const created = await createOffering({ data: validOfferingInput(), actorCustomerId });
      await transitionOffering({ offeringId: created.id, to: 'ARCHIVED', actorCustomerId });

      const rows = await auditRowsFor(created.id, 'offering.archived');
      expect(rows).toHaveLength(1);
    });

    it('an idempotent transition writes no second entry (test 12)', async () => {
      const { createOffering, transitionOffering } = await import('./offerings');
      const actorCustomerId = await actor();

      const created = await createOffering({ data: validOfferingInput(), actorCustomerId });
      await transitionOffering({ offeringId: created.id, to: 'PUBLISHED', actorCustomerId });
      await transitionOffering({ offeringId: created.id, to: 'PUBLISHED', actorCustomerId });

      const rows = await auditRowsFor(created.id, 'offering.published');
      expect(rows).toHaveLength(1);
    });
  });

  describe('scheduleOccurrence', () => {
    it('writes occurrence.scheduled (test 13)', async () => {
      const { scheduleOccurrence } = await import('./occurrences');
      const actorCustomerId = await actor();
      const offering = await seedPublishedOffering(actorCustomerId);

      const occurrence = await scheduleOccurrence({
        data: { offeringId: offering.id, startsAt: inMinutes(new Date(), 60), capacityOverride: null },
        actorCustomerId,
      });

      const rows = await auditRowsFor(occurrence.id, 'occurrence.scheduled');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.entityType).toBe('occurrence');
    });
  });

  describe('cancelOccurrence', () => {
    it('writes occurrence.cancelled (test 14)', async () => {
      const { scheduleOccurrence, cancelOccurrence } = await import('./occurrences');
      const actorCustomerId = await actor();
      const offering = await seedPublishedOffering(actorCustomerId);

      const occurrence = await scheduleOccurrence({
        data: { offeringId: offering.id, startsAt: inMinutes(new Date(), 60), capacityOverride: null },
        actorCustomerId,
      });
      await cancelOccurrence({ occurrenceId: occurrence.id, actorCustomerId });

      const rows = await auditRowsFor(occurrence.id, 'occurrence.cancelled');
      expect(rows).toHaveLength(1);
    });

    it('a refused cancellation writes no entry (test 15)', async () => {
      const { scheduleOccurrence, cancelOccurrence } = await import('./occurrences');
      const { OccurrenceHasReservationsError } = await import('./errors');
      const actorCustomerId = await actor();
      const offering = await seedPublishedOffering(actorCustomerId);

      const occurrence = await scheduleOccurrence({
        data: { offeringId: offering.id, startsAt: inMinutes(new Date(), 60), capacityOverride: null },
        actorCustomerId,
      });
      await seedConfirmedReservation(occurrence.id);

      await expect(
        cancelOccurrence({ occurrenceId: occurrence.id, actorCustomerId }),
      ).rejects.toBeInstanceOf(OccurrenceHasReservationsError);

      const rows = await auditRowsFor(occurrence.id, 'occurrence.cancelled');
      expect(rows).toHaveLength(0);
    });
  });

  describe('updateOccurrence', () => {
    it('records the capacity change (test 16)', async () => {
      const { scheduleOccurrence, updateOccurrence } = await import('./occurrences');
      const actorCustomerId = await actor();
      const offering = await seedPublishedOffering(actorCustomerId);

      const occurrence = await scheduleOccurrence({
        data: { offeringId: offering.id, startsAt: inMinutes(new Date(), 60), capacityOverride: 8 },
        actorCustomerId,
      });
      await updateOccurrence({
        occurrenceId: occurrence.id,
        data: { capacityOverride: 3 },
        actorCustomerId,
      });

      const rows = await auditRowsFor(occurrence.id, 'occurrence.updated');
      expect(rows).toHaveLength(1);
      const before = asRecord(rows[0]?.before);
      const after = asRecord(rows[0]?.after);
      expect(before['capacityOverride']).toBe(8);
      expect(after['capacityOverride']).toBe(3);
    });
  });

  describe('recordAuditEntry', () => {
    it('requires an executor (test 17)', () => {
      // Never invoked — this only has to compile-fail, not run. tsc still
      // type-checks the body of a function that's never called, which is
      // what makes @ts-expect-error catch a future caller that drops
      // `executor` and would otherwise write outside the transaction
      // silently.
      const attempt = async (): Promise<void> => {
        const { recordAuditEntry } = await import('./audit');
        const { createCustomerId } = await import('@keki/contracts');
        // @ts-expect-error executor is required, not optional.
        await recordAuditEntry({
          actorCustomerId: createCustomerId(crypto.randomUUID()),
          action: 'offering.created',
          entityType: 'offering',
          entityId: crypto.randomUUID(),
        });
      };
      expect(typeof attempt).toBe('function');
    });
  });
});
