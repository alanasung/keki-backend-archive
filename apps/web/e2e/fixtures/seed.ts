// Seeds Postgres test fixtures for the e2e suite. Imports `@keki/database`
// directly — WS-08 forbids that under `apps/web/app/`, but that boundary is
// application source; this directory is the documented exemption (see
// `tasks/phase-1-scaffold/WS-12-test-harness-ci.md` step 5), and
// `@keki/database` is declared as a devDependency of `apps/web` precisely so
// it cannot reach the production bundle.
import { customers, db, households } from '@keki/database';
import type { Role } from '@keki/contracts';
import { eq } from 'drizzle-orm';

export interface TestUser {
  readonly cognitoSub: string;
  readonly email: string;
  readonly role: Role;
}

/**
 * One fixed, deterministic user per role. A cognitoSub with no seeded
 * profile at all resolves to `unprovisioned` (WS-04), which is exactly the
 * case `UNPROVISIONED_COGNITO_SUB` below exercises by staying absent from
 * this table.
 */
export const TEST_USERS: Record<Role, TestUser> = {
  CUSTOMER: { cognitoSub: 'e2e|customer', email: 'e2e-customer@example.test', role: 'CUSTOMER' },
  FRONT_OF_HOUSE: {
    cognitoSub: 'e2e|front-of-house',
    email: 'e2e-front-of-house@example.test',
    role: 'FRONT_OF_HOUSE',
  },
  MANAGER: { cognitoSub: 'e2e|manager', email: 'e2e-manager@example.test', role: 'MANAGER' },
  ADMIN: { cognitoSub: 'e2e|admin', email: 'e2e-admin@example.test', role: 'ADMIN' },
};

/** Deliberately never inserted into `customers` — see `TEST_USERS` doc. */
export const UNPROVISIONED_COGNITO_SUB = 'e2e|unprovisioned';

async function upsertTestUser(user: TestUser): Promise<void> {
  const existing = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.cognitoSub, user.cognitoSub))
    .limit(1);

  if (existing[0] !== undefined) {
    await db
      .update(customers)
      .set({ email: user.email, role: user.role })
      .where(eq(customers.cognitoSub, user.cognitoSub));
    return;
  }

  const [household] = await db
    .insert(households)
    .values({ name: `E2E ${user.role} household` })
    .returning({ id: households.id });
  if (household === undefined) {
    throw new Error(`Failed to seed household for role ${user.role}`);
  }

  await db.insert(customers).values({
    householdId: household.id,
    cognitoSub: user.cognitoSub,
    email: user.email,
    firstName: 'E2E',
    lastName: user.role,
    role: user.role,
  });
}

/** Idempotent: safe to call once per `globalSetup` run against a reused branch. */
export async function seedTestUsers(): Promise<void> {
  for (const user of Object.values(TEST_USERS)) {
    await upsertTestUser(user);
  }
}
