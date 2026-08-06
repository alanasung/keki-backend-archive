import { describe, expect, it } from 'vitest';

const hasLiveDatabase =
  Boolean(process.env['DATABASE_URL_POOLED']) && Boolean(process.env['DATABASE_URL_DIRECT']);

// Requires a real Neon branch reachable via @keki/database's pooled
// connection string; skipped when those env vars are unset (e.g. locally
// without Neon credentials) and runs in CI once the branch is provisioned.
// Uses dynamic imports so that, when skipped, this file never triggers
// @keki/database's eager env validation at import time (see
// packages/database/src/client.ts and packages/database/src/schema/schema.test.ts
// for the same skipIf pattern).
describe.skipIf(!hasLiveDatabase)('integration: provisionCustomerProfile', () => {
  it('is idempotent on cognitoSub and creates exactly one household', async () => {
    const { provisionCustomerProfile } = await import('./commands');
    const { db, customers, households } = await import('@keki/database');
    const { eq } = await import('drizzle-orm');

    const cognitoSub = `cognito-${crypto.randomUUID()}`;
    const input = {
      cognitoSub,
      email: `${cognitoSub}@example.com`,
      firstName: 'Ada',
      lastName: 'Lovelace',
    };

    const first = await provisionCustomerProfile(input);
    const second = await provisionCustomerProfile(input);

    expect(second.id).toBe(first.id);
    expect(second.householdId).toBe(first.householdId);

    const customerRows = await db.select().from(customers).where(eq(customers.cognitoSub, cognitoSub));
    expect(customerRows).toHaveLength(1);

    const householdRows = await db
      .select()
      .from(households)
      .where(eq(households.id, first.householdId));
    expect(householdRows).toHaveLength(1);
  });
});
