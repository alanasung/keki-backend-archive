// Seeds Postgres test fixtures for the e2e suite. Imports `@keki/database`
// directly — WS-08 forbids that under `apps/web/app/`, but that boundary is
// application source; this directory is the documented exemption (see
// `tasks/phase-1-scaffold/WS-12-test-harness-ci.md` step 5), and
// `@keki/database` is declared as a devDependency of `apps/web` precisely so
// it cannot reach the production bundle.
import {
  catalogItems,
  children,
  customers,
  db,
  households,
  occurrences,
  offerings,
  reservationParticipants,
  reservations,
} from '@keki/database';
import type { Role } from '@keki/contracts';
import { eq, like } from 'drizzle-orm';

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

// ---------------------------------------------------------------------------
// Admin-catalog fixtures (WS-09 SC-16/SC-07): unlike the fixed-id fixtures
// above, admin-catalog.spec.ts creates its offering through the /admin UI
// itself, with a per-run unique name — the point of that journey is proving
// the UI's own create/publish/schedule path produces a bookable class, not
// seeding one directly. Nothing here is safe to upsert against, so this is a
// delete-by-name-prefix reset rather than a seed.
// ---------------------------------------------------------------------------

export const E2E_ADMIN_CATALOG_NAME_PREFIX = 'E2E Admin Catalog';

/**
 * Deletes every offering (and its occurrences) whose name starts with
 * `namePrefix`, in FK-safe order (occurrences before offerings). Call after
 * admin-catalog.spec.ts's journey so repeated local runs against a
 * persistent (non-CI) branch don't accumulate one throwaway class per run —
 * matches every run's leftovers, not only the current one, since a run that
 * was interrupted before its own cleanup would otherwise linger forever.
 */
export async function resetAdminCatalogOfferings(namePrefix: string): Promise<void> {
  const matches = await db
    .select({ id: offerings.id })
    .from(offerings)
    .where(like(offerings.name, `${namePrefix}%`));

  for (const { id } of matches) {
    await db.delete(occurrences).where(eq(occurrences.offeringId, id));
    await db.delete(offerings).where(eq(offerings.id, id));
  }
}

// ---------------------------------------------------------------------------
// Staff check-in fixtures (WS-09 SC-17): staff-check-in.spec.ts's journey
// needs an occurrence starting today, in the cafe's current day, that is
// already **in progress** — /staff/today's query excludes both yesterday and
// tomorrow, and an occurrence that hasn't started yet would leave the
// occupancy assertion (SC-17, the whole point of this program) nothing to
// count without an actual wait. `startsAt`/`endsAt` are computed relative to
// `now` at seed time, not a hardcoded instant, or the fixture stops being
// "today" tomorrow.
//
// One reservation with two participants, not two single-participant
// reservations: checking in the first participant must move the roll-up
// from 0 to 1 out of 2 while the reservation itself stays a single
// CONFIRMED/CHECKED_IN booking. A pair of single-participant reservations
// would produce the same before/after numbers for an entirely different
// reason (one whole reservation's seat count flipping, not a per-participant
// count inside one), so it wouldn't actually exercise the roll-up's
// granularity — see docs/testing.md.
//
// Fixed ids, upserted like every other fixture above; the reservation and
// its participants are explicitly reset to "nobody arrived" on every seed
// call, since a prior local run whose own undo step didn't run (a failed
// assertion mid-spec, say) would otherwise leave this fixture already
// checked in, and the journey's opening "0 arrived" assertion would be
// testing a lie.
// ---------------------------------------------------------------------------

export const E2E_STAFF_OFFERING = {
  id: 'a0000000-0000-4000-8000-000000000020',
  slug: 'e2e-staff-check-in-class',
  name: 'E2E Staff Check-in Class',
  priceCents: 2000,
  currency: 'USD',
  durationMinutes: 60,
  capacity: 20,
} as const;

export const E2E_STAFF_OCCURRENCE_ID = 'a0000000-0000-4000-8000-000000000021';
export const E2E_STAFF_RESERVATION_ID = 'a0000000-0000-4000-8000-000000000022';
export const E2E_STAFF_HOUSEHOLD_ID = 'a0000000-0000-4000-8000-000000000023';

const E2E_STAFF_PARENT = {
  id: 'a0000000-0000-4000-8000-000000000024',
  cognitoSub: 'e2e|staff-fixture-parent',
  email: 'e2e-staff-fixture-parent@example.test',
} as const;

export const E2E_STAFF_PARTICIPANTS = [
  {
    id: 'a0000000-0000-4000-8000-000000000025',
    childId: 'a0000000-0000-4000-8000-000000000027',
    firstName: 'Staff-Fixture',
    lastName: 'Attendee One',
  },
  {
    id: 'a0000000-0000-4000-8000-000000000026',
    childId: 'a0000000-0000-4000-8000-000000000028',
    firstName: 'Staff-Fixture',
    lastName: 'Attendee Two',
  },
] as const;

export const E2E_STAFF_PARTICIPANT_NAMES = E2E_STAFF_PARTICIPANTS.map(
  (participant) => `${participant.firstName} ${participant.lastName}`,
);

async function seedStaffHouseholdAndParent(): Promise<void> {
  await db
    .insert(households)
    .values({ id: E2E_STAFF_HOUSEHOLD_ID, name: 'E2E Staff Fixture Household' })
    .onConflictDoUpdate({ target: households.id, set: { name: 'E2E Staff Fixture Household' } });

  await db
    .insert(customers)
    .values({
      id: E2E_STAFF_PARENT.id,
      householdId: E2E_STAFF_HOUSEHOLD_ID,
      cognitoSub: E2E_STAFF_PARENT.cognitoSub,
      email: E2E_STAFF_PARENT.email,
      firstName: 'Staff-Fixture',
      lastName: 'Parent',
    })
    .onConflictDoUpdate({
      target: customers.id,
      set: { householdId: E2E_STAFF_HOUSEHOLD_ID, email: E2E_STAFF_PARENT.email },
    });
}

async function seedStaffChildren(): Promise<void> {
  for (const participant of E2E_STAFF_PARTICIPANTS) {
    await db
      .insert(children)
      .values({
        id: participant.childId,
        householdId: E2E_STAFF_HOUSEHOLD_ID,
        firstName: participant.firstName,
        lastName: participant.lastName,
        dateOfBirth: '2017-01-01',
      })
      .onConflictDoUpdate({
        target: children.id,
        set: { householdId: E2E_STAFF_HOUSEHOLD_ID, firstName: participant.firstName, lastName: participant.lastName },
      });
  }
}

async function seedStaffOfferingAndOccurrence(now: Date): Promise<{ startsAt: Date; endsAt: Date }> {
  await db
    .insert(offerings)
    .values({
      id: E2E_STAFF_OFFERING.id,
      slug: E2E_STAFF_OFFERING.slug,
      name: E2E_STAFF_OFFERING.name,
      type: 'CLASS',
      durationMinutes: E2E_STAFF_OFFERING.durationMinutes,
      defaultCapacity: E2E_STAFF_OFFERING.capacity,
      priceCents: E2E_STAFF_OFFERING.priceCents,
      currency: E2E_STAFF_OFFERING.currency,
      status: 'PUBLISHED',
    })
    .onConflictDoUpdate({
      target: offerings.id,
      set: { name: E2E_STAFF_OFFERING.name, defaultCapacity: E2E_STAFF_OFFERING.capacity, status: 'PUBLISHED' },
    });

  // In progress: started shortly before now, ends well after the journey's
  // read of /staff/occupancy.
  const startsAt = new Date(now.getTime() - 15 * 60_000);
  const endsAt = new Date(now.getTime() + 45 * 60_000);

  await db
    .insert(occurrences)
    .values({ id: E2E_STAFF_OCCURRENCE_ID, offeringId: E2E_STAFF_OFFERING.id, startsAt, endsAt, status: 'SCHEDULED' })
    .onConflictDoUpdate({
      target: occurrences.id,
      set: { startsAt, endsAt, status: 'SCHEDULED', capacityOverride: null },
    });

  return { startsAt, endsAt };
}

async function seedStaffReservationAndParticipants(): Promise<void> {
  await db
    .insert(reservations)
    .values({
      id: E2E_STAFF_RESERVATION_ID,
      occurrenceId: E2E_STAFF_OCCURRENCE_ID,
      householdId: E2E_STAFF_HOUSEHOLD_ID,
      createdByCustomerId: E2E_STAFF_PARENT.id,
      status: 'CONFIRMED',
      seatCount: E2E_STAFF_PARTICIPANTS.length,
    })
    .onConflictDoUpdate({
      target: reservations.id,
      set: {
        occurrenceId: E2E_STAFF_OCCURRENCE_ID,
        householdId: E2E_STAFF_HOUSEHOLD_ID,
        status: 'CONFIRMED',
        seatCount: E2E_STAFF_PARTICIPANTS.length,
      },
    });

  for (const participant of E2E_STAFF_PARTICIPANTS) {
    await db
      .insert(reservationParticipants)
      .values({
        id: participant.id,
        reservationId: E2E_STAFF_RESERVATION_ID,
        childId: participant.childId,
        checkedInAt: null,
      })
      .onConflictDoUpdate({
        target: reservationParticipants.id,
        set: { reservationId: E2E_STAFF_RESERVATION_ID, childId: participant.childId, checkedInAt: null },
      });
  }
}

/**
 * Idempotent: safe to call at the top of `staff-check-in.spec.ts` on every
 * run against a reused local branch. Returns the seeded occurrence's
 * `startsAt`/`endsAt` so the spec can assert it against
 * `cafeDayBounds(now)` itself, rather than trusting this function's own
 * arithmetic.
 */
export async function seedStaffCheckInFixtures(now: Date): Promise<{ startsAt: Date; endsAt: Date }> {
  await seedStaffHouseholdAndParent();
  await seedStaffChildren();
  const occurrence = await seedStaffOfferingAndOccurrence(now);
  await seedStaffReservationAndParticipants();
  return occurrence;
}
