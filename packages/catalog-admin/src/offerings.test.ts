import { describe, expect, it } from 'vitest';
import type { CreateOfferingInput } from '@keki/contracts';

const hasLiveDatabase =
  Boolean(process.env['DATABASE_URL_POOLED']) && Boolean(process.env['DATABASE_URL_DIRECT']);

// Every function under test reads or writes real `offerings` rows, and the
// concurrency tests (12, 21) depend on real Postgres row-locking that no
// stub can faithfully imitate. Skipped when Neon credentials are unset (e.g.
// locally) and runs in CI once the branch is provisioned. Uses dynamic
// imports so a skipped run never triggers @keki/database's eager env
// validation at import time (see
// packages/notification-core/src/outbox.test.ts for the same pattern).
//
// Follows commerce-core's isolation approach — per-test crypto.randomUUID()
// identifiers rather than truncation — so this suite cannot disturb others
// sharing the CI branch.
describe.skipIf(!hasLiveDatabase)('integration: catalog-admin offerings', () => {
  function validInput(overrides: Partial<CreateOfferingInput> = {}): CreateOfferingInput {
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

  async function seedRoomOffering() {
    const { db, offerings } = await import('@keki/database');
    const [row] = await db
      .insert(offerings)
      .values({
        slug: `room-${crypto.randomUUID()}`,
        name: `Test Room ${crypto.randomUUID()}`,
        type: 'ROOM',
        durationMinutes: 60,
        defaultCapacity: 4,
        priceCents: 0,
        status: 'DRAFT',
      })
      .returning();
    return row!;
  }

  describe('createOffering', () => {
    it('saves as DRAFT even though nothing asked for it (test 8, SC-01)', async () => {
      const { createOffering } = await import('./offerings');

      const offering = await createOffering({ data: validInput(), actorCustomerId: await actor() });

      expect(offering.status).toBe('DRAFT');
    });

    it('persists every field exactly as given (test 9)', async () => {
      const { createOffering } = await import('./offerings');

      const data = validInput({
        name: `Beginner Pottery ${crypto.randomUUID()}`,
        description: 'Hand-building basics',
        durationMinutes: 90,
        defaultCapacity: 8,
        priceCents: 4500,
      });

      const offering = await createOffering({ data, actorCustomerId: await actor() });

      expect(offering.name).toBe(data.name);
      expect(offering.description).toBe(data.description);
      expect(offering.durationMinutes).toBe(90);
      expect(offering.defaultCapacity).toBe(8);
      expect(offering.priceCents).toBe(4500);
    });

    it('rejects a non-CLASS type at parse and inserts nothing (test 10)', async () => {
      const { createOffering } = await import('./offerings');
      const { db, offerings } = await import('@keki/database');
      const { eq } = await import('drizzle-orm');

      const data = validInput();
      const invalid = { ...data, type: 'ROOM' } as unknown as CreateOfferingInput;

      await expect(createOffering({ data: invalid, actorCustomerId: await actor() })).rejects.toThrow();

      const rows = await db.select().from(offerings).where(eq(offerings.name, data.name));
      expect(rows).toHaveLength(0);
    });

    it('rejects a supplied status and inserts nothing (test 11)', async () => {
      const { createOffering } = await import('./offerings');
      const { db, offerings } = await import('@keki/database');
      const { eq } = await import('drizzle-orm');

      const data = validInput();
      const invalid = { ...data, status: 'PUBLISHED' } as unknown as CreateOfferingInput;

      await expect(createOffering({ data: invalid, actorCustomerId: await actor() })).rejects.toThrow();

      const rows = await db.select().from(offerings).where(eq(offerings.name, data.name));
      expect(rows).toHaveLength(0);
    });

    it('is atomic: an insert failure after slug generation leaves no row behind (test 12)', async () => {
      const { createOffering } = await import('./offerings');
      const { withTransaction, db, offerings } = await import('@keki/database');
      const { eq } = await import('drizzle-orm');

      const data = validInput();
      const actorCustomerId = await actor();

      // A stub executor that answers generateUniqueSlug's real SELECT (so
      // slug generation genuinely completes) but forces the subsequent
      // INSERT to throw. withTransaction rolls the real transaction back
      // on any thrown error, so this proves the row never lands rather than
      // merely that the override never ran.
      await expect(
        withTransaction((tx) => {
          const failingTx = {
            select: tx.select.bind(tx),
            insert: () => {
              throw new Error('forced insert failure for test 12');
            },
          };
          return createOffering({ data, actorCustomerId, tx: failingTx as unknown as typeof tx });
        }),
      ).rejects.toThrow('forced insert failure for test 12');

      const rows = await db.select().from(offerings).where(eq(offerings.name, data.name));
      expect(rows).toHaveLength(0);
    });
  });

  describe('updateOffering', () => {
    it('returns before and after (test 13)', async () => {
      const { createOffering, updateOffering } = await import('./offerings');
      const actorCustomerId = await actor();

      const created = await createOffering({ data: validInput({ priceCents: 1000 }), actorCustomerId });
      const { before, after } = await updateOffering({
        offeringId: created.id,
        data: { priceCents: 2000 },
        actorCustomerId,
      });

      expect(before.priceCents).toBe(1000);
      expect(after.priceCents).toBe(2000);
    });

    it('leaves the slug unchanged when the name changes (test 14)', async () => {
      const { createOffering, updateOffering } = await import('./offerings');
      const actorCustomerId = await actor();

      const created = await createOffering({ data: validInput(), actorCustomerId });
      const { after } = await updateOffering({
        offeringId: created.id,
        data: { name: `Renamed ${crypto.randomUUID()}` },
        actorCustomerId,
      });

      expect(after.slug).toBe(created.slug);
    });

    it('refuses to edit an archived offering (test 15)', async () => {
      const { createOffering, updateOffering, transitionOffering } = await import('./offerings');
      const { getOfferingById } = await import('./queries');
      const actorCustomerId = await actor();

      const created = await createOffering({ data: validInput({ priceCents: 1000 }), actorCustomerId });
      await transitionOffering({ offeringId: created.id, to: 'ARCHIVED', actorCustomerId });

      await expect(
        updateOffering({ offeringId: created.id, data: { priceCents: 2000 }, actorCustomerId }),
      ).rejects.toThrow();

      const unchanged = await getOfferingById(created.id);
      expect(unchanged?.priceCents).toBe(1000);
    });

    it('refuses to edit a non-CLASS offering', async () => {
      const { updateOffering } = await import('./offerings');
      const { UnsupportedOfferingTypeError } = await import('./errors');

      const room = await seedRoomOffering();
      const { createOfferingId } = await import('@keki/contracts');

      await expect(
        updateOffering({
          offeringId: createOfferingId(room.id),
          data: { priceCents: 500 },
          actorCustomerId: await actor(),
        }),
      ).rejects.toBeInstanceOf(UnsupportedOfferingTypeError);
    });
  });

  describe('transitionOffering', () => {
    it('publishes a draft (test 16, SC-03)', async () => {
      const { createOffering, transitionOffering } = await import('./offerings');
      const actorCustomerId = await actor();

      const created = await createOffering({ data: validInput(), actorCustomerId });
      const result = await transitionOffering({ offeringId: created.id, to: 'PUBLISHED', actorCustomerId });

      expect(result.offering.status).toBe('PUBLISHED');
      expect(result.changed).toBe(true);
    });

    it('unpublishes: PUBLISHED -> DRAFT succeeds (test 17)', async () => {
      const { createOffering, transitionOffering } = await import('./offerings');
      const actorCustomerId = await actor();

      const created = await createOffering({ data: validInput(), actorCustomerId });
      await transitionOffering({ offeringId: created.id, to: 'PUBLISHED', actorCustomerId });
      const result = await transitionOffering({ offeringId: created.id, to: 'DRAFT', actorCustomerId });

      expect(result.offering.status).toBe('DRAFT');
      expect(result.changed).toBe(true);
    });

    it('archives from either DRAFT or PUBLISHED (test 18)', async () => {
      const { createOffering, transitionOffering } = await import('./offerings');
      const actorCustomerId = await actor();

      const fromDraft = await createOffering({ data: validInput(), actorCustomerId });
      const draftResult = await transitionOffering({
        offeringId: fromDraft.id,
        to: 'ARCHIVED',
        actorCustomerId,
      });
      expect(draftResult.offering.status).toBe('ARCHIVED');

      const fromPublished = await createOffering({ data: validInput(), actorCustomerId });
      await transitionOffering({ offeringId: fromPublished.id, to: 'PUBLISHED', actorCustomerId });
      const publishedResult = await transitionOffering({
        offeringId: fromPublished.id,
        to: 'ARCHIVED',
        actorCustomerId,
      });
      expect(publishedResult.offering.status).toBe('ARCHIVED');
    });

    it('refuses an undeclared edge: ARCHIVED -> PUBLISHED (test 19)', async () => {
      const { createOffering, transitionOffering } = await import('./offerings');
      const { InvalidOfferingTransitionError } = await import('./errors');
      const { getOfferingById } = await import('./queries');
      const actorCustomerId = await actor();

      const created = await createOffering({ data: validInput(), actorCustomerId });
      await transitionOffering({ offeringId: created.id, to: 'ARCHIVED', actorCustomerId });

      const attempt = transitionOffering({ offeringId: created.id, to: 'PUBLISHED', actorCustomerId });
      await expect(attempt).rejects.toBeInstanceOf(InvalidOfferingTransitionError);
      await expect(attempt).rejects.toMatchObject({ from: 'ARCHIVED', to: 'PUBLISHED' });

      const unchanged = await getOfferingById(created.id);
      expect(unchanged?.status).toBe('ARCHIVED');
    });

    it('is idempotent: publishing twice reports changed: false the second time (test 20)', async () => {
      const { createOffering, transitionOffering } = await import('./offerings');
      const actorCustomerId = await actor();

      const created = await createOffering({ data: validInput(), actorCustomerId });
      const first = await transitionOffering({ offeringId: created.id, to: 'PUBLISHED', actorCustomerId });
      const second = await transitionOffering({ offeringId: created.id, to: 'PUBLISHED', actorCustomerId });

      expect(first.changed).toBe(true);
      expect(second.changed).toBe(false);
    });

    it(
      'concurrent publishes on one draft produce exactly one change (test 21)',
      async () => {
        const { createOffering, transitionOffering } = await import('./offerings');
        const actorCustomerId = await actor();

        const created = await createOffering({ data: validInput(), actorCustomerId });

        const [first, second] = await Promise.all([
          transitionOffering({ offeringId: created.id, to: 'PUBLISHED', actorCustomerId }),
          transitionOffering({ offeringId: created.id, to: 'PUBLISHED', actorCustomerId }),
        ]);

        const changedCount = [first, second].filter((result) => result.changed).length;
        expect(changedCount).toBe(1);
        expect(first.offering.status).toBe('PUBLISHED');
        expect(second.offering.status).toBe('PUBLISHED');
      },
      10_000,
    );

    it('refuses to transition a non-CLASS offering', async () => {
      const { transitionOffering } = await import('./offerings');
      const { UnsupportedOfferingTypeError } = await import('./errors');
      const { createOfferingId } = await import('@keki/contracts');

      const room = await seedRoomOffering();

      await expect(
        transitionOffering({
          offeringId: createOfferingId(room.id),
          to: 'PUBLISHED',
          actorCustomerId: await actor(),
        }),
      ).rejects.toBeInstanceOf(UnsupportedOfferingTypeError);
    });
  });

  describe('listOfferings', () => {
    it('includes drafts and archived offerings, unlike catalog-core (test 22)', async () => {
      const { createOffering, transitionOffering } = await import('./offerings');
      const { listOfferings } = await import('./queries');
      const actorCustomerId = await actor();

      const draft = await createOffering({ data: validInput(), actorCustomerId });
      const publishedSource = await createOffering({ data: validInput(), actorCustomerId });
      const published = await transitionOffering({
        offeringId: publishedSource.id,
        to: 'PUBLISHED',
        actorCustomerId,
      });
      const archivedSource = await createOffering({ data: validInput(), actorCustomerId });
      const archived = await transitionOffering({
        offeringId: archivedSource.id,
        to: 'ARCHIVED',
        actorCustomerId,
      });

      const all = await listOfferings();
      const byId = new Map(all.map((offering) => [offering.id, offering]));

      expect(byId.get(draft.id)?.status).toBe('DRAFT');
      expect(byId.get(published.offering.id)?.status).toBe('PUBLISHED');
      expect(byId.get(archived.offering.id)?.status).toBe('ARCHIVED');
    });
  });
});
