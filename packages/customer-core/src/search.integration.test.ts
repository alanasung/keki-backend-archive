import { describe, expect, it } from 'vitest';

const hasLiveDatabase =
  Boolean(process.env['DATABASE_URL_POOLED']) && Boolean(process.env['DATABASE_URL_DIRECT']);

// Requires a real Neon branch reachable via @keki/database's pooled and
// direct connection strings; skipped when those env vars are unset. Isolated
// by per-test `crypto.randomUUID()` identifiers rather than truncation,
// matching packages/customer-core/src/children.integration.test.ts. Uses
// dynamic imports so a skipped run never triggers @keki/database's eager env
// validation at import time.
describe.skipIf(!hasLiveDatabase)('integration: customer-core search', () => {
  async function seedCustomer(overrides: {
    firstName?: string;
    lastName?: string;
    email?: string;
  } = {}) {
    const { db, customers, households } = await import('@keki/database');
    const suffix = crypto.randomUUID();
    const [household] = await db.insert(households).values({ name: `WS-08 Household ${suffix}` }).returning();
    const [customer] = await db
      .insert(customers)
      .values({
        householdId: household!.id,
        cognitoSub: `cognito-${suffix}`,
        email: overrides.email ?? `${suffix}@example.test`,
        firstName: overrides.firstName ?? 'Grace',
        lastName: overrides.lastName ?? `Hopper-${suffix}`,
      })
      .returning();
    return { customer: customer!, household: household! };
  }

  // Test 1 — SC-16's core.
  it('finds by exact email', async () => {
    const { searchCustomers } = await import('./queries');
    const { customer } = await seedCustomer({ email: `ada-${crypto.randomUUID()}@example.test` });

    const results = await searchCustomers({ query: customer.email! });

    expect(results.map((r) => r.customerId)).toContain(customer.id);
  });

  // Test 2 — proves the query does not defeat citext's built-in
  // case-insensitivity.
  it('is case-insensitive on email', async () => {
    const suffix = crypto.randomUUID();
    const { customer } = await seedCustomer({ email: `Ada-${suffix}@Example.test` });

    const { searchCustomers } = await import('./queries');
    const results = await searchCustomers({ query: `ada-${suffix}@example.test` });

    expect(results.map((r) => r.customerId)).toContain(customer.id);
  });

  // Test 3
  it('finds by partial last name', async () => {
    const { searchCustomers } = await import('./queries');
    const suffix = crypto.randomUUID();
    const { customer } = await seedCustomer({ lastName: `Lovelace-${suffix}` });

    const results = await searchCustomers({ query: `ovelace-${suffix}` });

    expect(results.map((r) => r.customerId)).toContain(customer.id);
  });

  // Test 4
  it('finds by partial first name', async () => {
    const { searchCustomers } = await import('./queries');
    const suffix = crypto.randomUUID();
    const { customer } = await seedCustomer({ firstName: `Adalovelace${suffix}` });

    const results = await searchCustomers({ query: `alovelace${suffix}` });

    expect(results.map((r) => r.customerId)).toContain(customer.id);
  });

  // Test 5
  it('returns an empty array for a non-matching term', async () => {
    const { searchCustomers } = await import('./queries');

    const results = await searchCustomers({ query: `no-such-customer-${crypto.randomUUID()}` });

    expect(results).toEqual([]);
  });

  // Test 6
  it('refuses a one-character query', async () => {
    const { searchCustomers } = await import('./queries');
    const { SearchQueryTooShortError } = await import('./errors');

    await expect(searchCustomers({ query: 'a' })).rejects.toBeInstanceOf(SearchQueryTooShortError);
  });

  // Test 7
  it('respects the limit', async () => {
    const { searchCustomers } = await import('./queries');
    const suffix = crypto.randomUUID();
    const sharedLastName = `Limitcheck-${suffix}`;
    await Promise.all(Array.from({ length: 30 }, () => seedCustomer({ lastName: sharedLastName })));

    const results = await searchCustomers({ query: sharedLastName, limit: 25 });

    expect(results).toHaveLength(25);
  });

  // Test 8
  it('carries the household id on each result', async () => {
    const { searchCustomers } = await import('./queries');
    const suffix = crypto.randomUUID();
    const { customer, household } = await seedCustomer({ lastName: `Householdcheck-${suffix}` });

    const results = await searchCustomers({ query: `Householdcheck-${suffix}` });

    const result = results.find((r) => r.customerId === customer.id);
    expect(result?.householdId).toBe(household.id);
  });

  // Test 9 — reconstructs searchCustomers' exact where-condition builder
  // against a real `db`, rather than a hand-copied condition, so a
  // regression to `lower(email)` fails this test.
  it('does not lower-case the email column', async () => {
    const { db, customers } = await import('@keki/database');
    const { buildCustomerSearchCondition } = await import('./queries');

    const { sql } = db
      .select()
      .from(customers)
      .where(buildCustomerSearchCondition('ada@example.test'))
      .limit(25)
      .toSQL();

    expect(sql.toLowerCase()).not.toMatch(/lower\s*\(/);
  });
});
