// Seeds Postgres test fixtures for the e2e suite. Imports `@keki/database`
// directly — WS-08 forbids that under `apps/web/app/`, but that boundary is
// application source; this directory is the documented exemption (see
// `tasks/phase-1-scaffold/WS-12-test-harness-ci.md` step 5), and
// `@keki/database` is declared as a devDependency of `apps/web` precisely so
// it cannot reach the production bundle.
import { catalogItems, children, customers, db, households, occurrences, offerings } from '@keki/database';
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

// ---------------------------------------------------------------------------
// Ordering fixtures (WS-12 SC-15): a cafe item, a bookable class occurrence,
// and a child under TEST_USERS.CUSTOMER's household — so ordering.spec.ts can
// exercise browse -> participant selection -> cart -> checkout against known
// prices and a real child, rather than the account holder booking themself.
//
// Every row below uses a fixed id and is upserted (never inserted fresh) for
// the same reason seedTestUsers is idempotent: safe to call once per
// `globalSetup` run against a reused local branch without accumulating
// duplicate cards on the /book page across repeated local runs. Capacity is
// set generously high (see E2E_CLASS_OFFERING.capacity) because — unlike
// seedTestUsers — this fixture's occurrence does accumulate reservations
// across reruns against a persistent (non-CI) branch; a capacity in the
// thousands makes that practically irrelevant rather than requiring a full
// cascade-delete of reservations/order line items on every setup.
// ---------------------------------------------------------------------------

export const E2E_CAFE_ITEM = {
  id: 'a0000000-0000-4000-8000-000000000001',
  squareCatalogObjectId: 'e2e-cafe-item-object',
  squareVariationId: 'e2e-cafe-item-variation',
  name: 'E2E Seeded Latte',
  priceCents: 450,
  currency: 'USD',
} as const;

export const E2E_CLASS_OFFERING = {
  id: 'a0000000-0000-4000-8000-000000000002',
  slug: 'e2e-seeded-pottery-class',
  name: 'E2E Seeded Pottery Class',
  priceCents: 3500,
  currency: 'USD',
  durationMinutes: 60,
  capacity: 5000,
} as const;

export const E2E_OCCURRENCE_ID = 'a0000000-0000-4000-8000-000000000003';

export const E2E_CHILD = {
  id: 'a0000000-0000-4000-8000-000000000004',
  firstName: 'E2E',
  lastName: 'Kiddo',
  dateOfBirth: '2018-06-01',
} as const;

export const E2E_CHILD_DISPLAY_NAME = `${E2E_CHILD.firstName} ${E2E_CHILD.lastName}`;

async function getCustomerHouseholdId(cognitoSub: string): Promise<string> {
  const rows = await db
    .select({ householdId: customers.householdId })
    .from(customers)
    .where(eq(customers.cognitoSub, cognitoSub))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new Error(
      `getCustomerHouseholdId: no customer row for cognitoSub "${cognitoSub}" — seedTestUsers() must run first.`,
    );
  }
  return row.householdId;
}

async function seedCafeItem(): Promise<void> {
  await db
    .insert(catalogItems)
    .values({
      id: E2E_CAFE_ITEM.id,
      squareCatalogObjectId: E2E_CAFE_ITEM.squareCatalogObjectId,
      squareVariationId: E2E_CAFE_ITEM.squareVariationId,
      name: E2E_CAFE_ITEM.name,
      priceCents: E2E_CAFE_ITEM.priceCents,
      currency: E2E_CAFE_ITEM.currency,
      status: 'ACTIVE',
    })
    .onConflictDoUpdate({
      target: catalogItems.id,
      set: { name: E2E_CAFE_ITEM.name, priceCents: E2E_CAFE_ITEM.priceCents, status: 'ACTIVE' },
    });
}

async function seedClassOccurrence(): Promise<void> {
  await db
    .insert(offerings)
    .values({
      id: E2E_CLASS_OFFERING.id,
      slug: E2E_CLASS_OFFERING.slug,
      name: E2E_CLASS_OFFERING.name,
      type: 'CLASS',
      durationMinutes: E2E_CLASS_OFFERING.durationMinutes,
      defaultCapacity: E2E_CLASS_OFFERING.capacity,
      priceCents: E2E_CLASS_OFFERING.priceCents,
      currency: E2E_CLASS_OFFERING.currency,
      status: 'PUBLISHED',
    })
    .onConflictDoUpdate({
      target: offerings.id,
      set: {
        name: E2E_CLASS_OFFERING.name,
        defaultCapacity: E2E_CLASS_OFFERING.capacity,
        priceCents: E2E_CLASS_OFFERING.priceCents,
        status: 'PUBLISHED',
      },
    });

  // Refreshed on every call so the occurrence is always in the future,
  // regardless of how much time has passed since it was first seeded —
  // listBookableOfferings only returns occurrences with startsAt >= now.
  const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const endsAt = new Date(startsAt.getTime() + E2E_CLASS_OFFERING.durationMinutes * 60_000);

  await db
    .insert(occurrences)
    .values({
      id: E2E_OCCURRENCE_ID,
      offeringId: E2E_CLASS_OFFERING.id,
      startsAt,
      endsAt,
      status: 'SCHEDULED',
    })
    .onConflictDoUpdate({
      target: occurrences.id,
      set: { startsAt, endsAt, status: 'SCHEDULED', capacityOverride: null },
    });
}

async function seedChild(): Promise<void> {
  const householdId = await getCustomerHouseholdId(TEST_USERS.CUSTOMER.cognitoSub);
  await db
    .insert(children)
    .values({
      id: E2E_CHILD.id,
      householdId,
      firstName: E2E_CHILD.firstName,
      lastName: E2E_CHILD.lastName,
      dateOfBirth: E2E_CHILD.dateOfBirth,
    })
    .onConflictDoUpdate({
      target: children.id,
      set: { householdId, firstName: E2E_CHILD.firstName, lastName: E2E_CHILD.lastName },
    });
}

/**
 * Idempotent: safe to call once per `globalSetup` run against a reused
 * branch, same as `seedTestUsers`. Must run after `seedTestUsers()` — it
 * seeds the child under TEST_USERS.CUSTOMER's household.
 */
export async function seedOrderingFixtures(): Promise<void> {
  await Promise.all([seedCafeItem(), seedClassOccurrence()]);
  await seedChild();
}
