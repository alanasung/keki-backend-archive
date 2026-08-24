import { describe, expect, it } from 'vitest';

const hasLiveDatabase =
  Boolean(process.env['DATABASE_URL_POOLED']) && Boolean(process.env['DATABASE_URL_DIRECT']);

// Requires a real Neon branch reachable via @keki/database's pooled and
// direct connection strings (withTransaction needs the neon-serverless
// driver — see packages/database/src/transaction.ts); skipped when those env
// vars are unset. Isolated by per-test `crypto.randomUUID()` identifiers
// rather than truncation, matching packages/customer-core/src/commands.integration.test.ts
// and packages/reservation-core/src/queries.integration.test.ts. Uses dynamic
// imports so a skipped run never triggers @keki/database's eager env
// validation at import time.
describe.skipIf(!hasLiveDatabase)('integration: customer-core children', () => {
  async function seedHousehold(name = `WS-06 Household ${crypto.randomUUID()}`) {
    const { db, households } = await import('@keki/database');
    const [household] = await db.insert(households).values({ name }).returning();
    return household!;
  }

  // provisionCustomerProfile is the only path that assigns
  // households.primary_customer_id, and updateHousehold refuses to operate
  // on a household that was never finished provisioning (mirroring
  // queries.ts's toHousehold) — a real updateHousehold caller only ever
  // targets its own session's household, which is always fully provisioned.
  async function seedProvisionedHousehold() {
    const { provisionCustomerProfile } = await import('./commands');
    const { db, households } = await import('@keki/database');
    const { eq } = await import('drizzle-orm');
    const cognitoSub = `cognito-${crypto.randomUUID()}`;
    const customer = await provisionCustomerProfile({
      cognitoSub,
      email: `${cognitoSub}@example.com`,
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
    const [household] = await db.select().from(households).where(eq(households.id, customer.householdId));
    return { customer, household: household! };
  }

  describe('addChild', () => {
    it('creates a child in the named household', async () => {
      const { addChild } = await import('./commands');
      const { createHouseholdId } = await import('@keki/contracts');

      const household = await seedHousehold();

      const child = await addChild({
        householdId: createHouseholdId(household.id),
        firstName: 'Grace',
        lastName: 'Lovelace',
        dateOfBirth: new Date('2019-03-04T12:00:00Z'),
      });

      expect(child.householdId).toBe(household.id);
      expect(child.firstName).toBe('Grace');
      expect(child.lastName).toBe('Lovelace');
    });

    it('appears in listHouseholdMembers, since that read is what the booking participant picker uses', async () => {
      const { addChild } = await import('./commands');
      const { listHouseholdMembers } = await import('./queries');
      const { createHouseholdId } = await import('@keki/contracts');

      const household = await seedHousehold();
      const householdId = createHouseholdId(household.id);
      const child = await addChild({
        householdId,
        firstName: 'Grace',
        lastName: 'Lovelace',
        dateOfBirth: new Date('2019-03-04T12:00:00Z'),
      });

      const members = await listHouseholdMembers(householdId);

      expect(members.children.map((c) => c.id)).toContain(child.id);
    });

    it("does not appear in another household's members", async () => {
      const { addChild } = await import('./commands');
      const { listHouseholdMembers } = await import('./queries');
      const { createHouseholdId } = await import('@keki/contracts');

      const targetHousehold = await seedHousehold();
      const otherHousehold = await seedHousehold();

      await addChild({
        householdId: createHouseholdId(targetHousehold.id),
        firstName: 'Grace',
        lastName: 'Lovelace',
        dateOfBirth: new Date('2019-03-04T12:00:00Z'),
      });

      const otherMembers = await listHouseholdMembers(createHouseholdId(otherHousehold.id));

      expect(otherMembers.children).toHaveLength(0);
    });

    it('stores the exact calendar date, not the day before or after', async () => {
      const { addChild } = await import('./commands');
      const { createHouseholdId } = await import('@keki/contracts');

      const household = await seedHousehold();

      const child = await addChild({
        householdId: createHouseholdId(household.id),
        firstName: 'Grace',
        lastName: 'Lovelace',
        // Noon UTC, deliberately far from either local timezone boundary,
        // so this test isolates the "wrong calendar day" bug rather than
        // the "wrong time of day" one covered below.
        dateOfBirth: new Date('2019-03-04T12:00:00Z'),
      });

      expect(child.dateOfBirth.toISOString().slice(0, 10)).toBe('2019-03-04');
    });

    it('does not shift a day for a late-evening local Date', async () => {
      const { addChild } = await import('./commands');
      const { createHouseholdId } = await import('@keki/contracts');

      const household = await seedHousehold();
      // Constructed from local components: 2019-03-04 at 23:30 local time.
      // A naive `toISOString()`-based formatter would push this into
      // 2019-03-05 for any timezone west of UTC.
      const lateEvening = new Date(2019, 2, 4, 23, 30);

      const child = await addChild({
        householdId: createHouseholdId(household.id),
        firstName: 'Grace',
        lastName: 'Lovelace',
        dateOfBirth: lateEvening,
      });

      expect(child.dateOfBirth.getUTCFullYear()).toBe(2019);
      expect(child.dateOfBirth.getUTCMonth()).toBe(2);
      expect(child.dateOfBirth.getUTCDate()).toBe(4);
    });

    it('refuses a future date of birth and inserts no row', async () => {
      const { addChild } = await import('./commands');
      const { listHouseholdMembers } = await import('./queries');
      const { createHouseholdId } = await import('@keki/contracts');
      const { InvalidDateOfBirthError } = await import('./errors');

      const household = await seedHousehold();
      const householdId = createHouseholdId(household.id);
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);

      await expect(
        addChild({ householdId, firstName: 'Grace', lastName: 'Lovelace', dateOfBirth: tomorrow }),
      ).rejects.toBeInstanceOf(InvalidDateOfBirthError);

      const members = await listHouseholdMembers(householdId);
      expect(members.children).toHaveLength(0);
    });

    it("accepts today's date of birth", async () => {
      const { addChild } = await import('./commands');
      const { createHouseholdId } = await import('@keki/contracts');

      const household = await seedHousehold();

      const child = await addChild({
        householdId: createHouseholdId(household.id),
        firstName: 'Grace',
        lastName: 'Lovelace',
        dateOfBirth: new Date(),
      });

      expect(child.id).toBeDefined();
    });

    it('throws HouseholdNotFoundError, not a foreign-key error, for an unknown household', async () => {
      const { addChild } = await import('./commands');
      const { listHouseholdMembers } = await import('./queries');
      const { createHouseholdId } = await import('@keki/contracts');
      const { HouseholdNotFoundError } = await import('./errors');

      const unknownHouseholdId = createHouseholdId(crypto.randomUUID());

      await expect(
        addChild({
          householdId: unknownHouseholdId,
          firstName: 'Grace',
          lastName: 'Lovelace',
          dateOfBirth: new Date('2019-03-04T12:00:00Z'),
        }),
      ).rejects.toBeInstanceOf(HouseholdNotFoundError);

      const members = await listHouseholdMembers(unknownHouseholdId);
      expect(members.children).toHaveLength(0);
    });

    it(
      'honours a supplied transaction: rolling it back leaves no child row',
      async () => {
        const { addChild } = await import('./commands');
        const { createHouseholdId } = await import('@keki/contracts');
        const { db, children, withTransaction } = await import('@keki/database');
        const { eq } = await import('drizzle-orm');

        const household = await seedHousehold();
        const householdId = createHouseholdId(household.id);

        class RollbackSentinel extends Error {}

        await expect(
          withTransaction(async (tx) => {
            await addChild({
              householdId,
              firstName: 'Grace',
              lastName: 'Lovelace',
              dateOfBirth: new Date('2019-03-04T12:00:00Z'),
              tx,
            });
            throw new RollbackSentinel();
          }),
        ).rejects.toBeInstanceOf(RollbackSentinel);

        const rows = await db.select().from(children).where(eq(children.householdId, householdId));
        expect(rows).toHaveLength(0);
      },
      10_000,
    );

    it('allows two children to share a name in one household', async () => {
      const { addChild } = await import('./commands');
      const { listHouseholdMembers } = await import('./queries');
      const { createHouseholdId } = await import('@keki/contracts');

      const household = await seedHousehold();
      const householdId = createHouseholdId(household.id);

      await addChild({ householdId, firstName: 'Grace', lastName: 'Lovelace', dateOfBirth: new Date('2019-03-04T12:00:00Z') });
      await addChild({ householdId, firstName: 'Grace', lastName: 'Lovelace', dateOfBirth: new Date('2019-03-04T12:00:00Z') });

      const members = await listHouseholdMembers(householdId);
      expect(members.children).toHaveLength(2);
    });
  });

  describe('updateHousehold', () => {
    it('renames the household', async () => {
      const { updateHousehold } = await import('./commands');
      const { getHouseholdById } = await import('./queries');
      const { createHouseholdId } = await import('@keki/contracts');

      const { household } = await seedProvisionedHousehold();
      const householdId = createHouseholdId(household.id);
      const newName = `Renamed Household ${crypto.randomUUID()}`;

      const updated = await updateHousehold({ householdId, name: newName });

      expect(updated.name).toBe(newName);
      const stored = await getHouseholdById(householdId);
      expect(stored?.id).toBe(household.id);
    });

    it('advances updated_at', async () => {
      const { updateHousehold } = await import('./commands');
      const { createHouseholdId } = await import('@keki/contracts');

      const { household } = await seedProvisionedHousehold();
      const householdId = createHouseholdId(household.id);

      const updated = await updateHousehold({ householdId, name: `Renamed ${crypto.randomUUID()}` });

      expect(updated.updatedAt.getTime()).toBeGreaterThan(household.updatedAt.getTime());
    });

    it('leaves primary_customer_id untouched', async () => {
      const { updateHousehold } = await import('./commands');

      const { customer } = await seedProvisionedHousehold();

      const updated = await updateHousehold({
        householdId: customer.householdId,
        name: `Renamed ${crypto.randomUUID()}`,
      });

      expect(updated.primaryCustomerId).toBe(customer.id);
    });

    it('does not rename a different household', async () => {
      const { updateHousehold } = await import('./commands');
      const { getHouseholdById } = await import('./queries');
      const { createHouseholdId } = await import('@keki/contracts');

      const { household: target } = await seedProvisionedHousehold();
      const { household: other } = await seedProvisionedHousehold();

      await updateHousehold({ householdId: createHouseholdId(target.id), name: `Renamed ${crypto.randomUUID()}` });

      const otherStored = await getHouseholdById(createHouseholdId(other.id));
      expect(otherStored?.id).toBe(other.id);
      // Re-fetch via raw select since the Household contract type carries
      // no `name`; the point is only that the untouched row still exists
      // and was not the one just renamed.
      const { db, households } = await import('@keki/database');
      const { eq } = await import('drizzle-orm');
      const [otherRow] = await db.select().from(households).where(eq(households.id, other.id));
      expect(otherRow?.name).toBe(other.name);
    });

    it('throws HouseholdNotFoundError for an unknown household', async () => {
      const { updateHousehold } = await import('./commands');
      const { createHouseholdId } = await import('@keki/contracts');
      const { HouseholdNotFoundError } = await import('./errors');

      const unknownHouseholdId = createHouseholdId(crypto.randomUUID());

      await expect(
        updateHousehold({ householdId: unknownHouseholdId, name: 'New Name' }),
      ).rejects.toBeInstanceOf(HouseholdNotFoundError);
    });

    it(
      'honours a supplied transaction: rolling it back leaves the original name',
      async () => {
        const { updateHousehold } = await import('./commands');
        const { createHouseholdId } = await import('@keki/contracts');
        const { withTransaction, db, households } = await import('@keki/database');
        const { eq } = await import('drizzle-orm');

        const { household } = await seedProvisionedHousehold();
        const householdId = createHouseholdId(household.id);

        class RollbackSentinel extends Error {}

        await expect(
          withTransaction(async (tx) => {
            await updateHousehold({ householdId, name: `Renamed ${crypto.randomUUID()}`, tx });
            throw new RollbackSentinel();
          }),
        ).rejects.toBeInstanceOf(RollbackSentinel);

        const [row] = await db.select().from(households).where(eq(households.id, household.id));
        expect(row?.name).toBe(household.name);
      },
      10_000,
    );
  });

  it('neither addChild nor updateHousehold writes to staff_audit_log', async () => {
    const { addChild, updateHousehold } = await import('./commands');
    const { createHouseholdId } = await import('@keki/contracts');
    const { db, staffAuditLog } = await import('@keki/database');
    const { eq } = await import('drizzle-orm');

    const { household } = await seedProvisionedHousehold();
    const householdId = createHouseholdId(household.id);

    const child = await addChild({
      householdId,
      firstName: 'Grace',
      lastName: 'Lovelace',
      dateOfBirth: new Date('2019-03-04T12:00:00Z'),
    });
    await updateHousehold({ householdId, name: `Renamed ${crypto.randomUUID()}` });

    const householdAuditRows = await db.select().from(staffAuditLog).where(eq(staffAuditLog.entityId, householdId));
    const childAuditRows = await db.select().from(staffAuditLog).where(eq(staffAuditLog.entityId, child.id));

    expect(householdAuditRows).toHaveLength(0);
    expect(childAuditRows).toHaveLength(0);
  });
});
