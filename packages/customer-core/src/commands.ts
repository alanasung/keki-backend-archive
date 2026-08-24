import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { children, customers, db, households, withTransaction, type Tx } from '@keki/database';
import {
  createChildId,
  createCustomerId,
  createHouseholdId,
  NotImplementedInPhase1,
  type Child,
  type Customer,
  type Household,
  type HouseholdId,
  type WaiverProvider,
} from '@keki/contracts';
import { HouseholdNotFoundError, InvalidDateOfBirthError } from './errors';
import { toCustomer } from './queries';

// `date_of_birth` is a `date` column (see packages/database/src/schema/people.ts),
// which Drizzle reads and writes as a plain `YYYY-MM-DD` string, not a
// timestamp. Formatting via the local getters (rather than
// `toISOString().slice(0, 10)`, which normalizes through UTC first) keeps a
// late-evening local `Date` on its own calendar day instead of rolling it
// into tomorrow.
function toCalendarDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function findCustomerByCognitoSub(cognitoSub: string): Promise<Customer | null> {
  const rows = await db.select().from(customers).where(eq(customers.cognitoSub, cognitoSub)).limit(1);
  const row = rows[0];
  return row === undefined ? null : toCustomer(row);
}

// Idempotent on `cognitoSub`: WS-04's `unprovisioned` session state calls
// this to create the Postgres side of a Cognito identity, and a retried or
// duplicated call (e.g. two tabs completing profile setup at once) must not
// create a second household.
//
// The `db` exported by @keki/database is a neon-http client, which has no
// real `db.transaction()` — it throws at runtime (see
// drizzle-orm/neon-http/session.js). `db.batch()` is the closest available
// primitive: the household and customer inserts run as a single Neon HTTP
// round trip. The customer insert no-ops on a `cognito_sub` conflict instead
// of a racy check-then-insert; on the rare lost race, the speculative
// household created alongside it is deleted and the winning row is returned.
export async function provisionCustomerProfile(input: {
  cognitoSub: string;
  email: string;
  firstName?: string;
  lastName?: string;
}): Promise<Customer> {
  const existing = await findCustomerByCognitoSub(input.cognitoSub);
  if (existing !== null) {
    return existing;
  }

  const householdId = randomUUID();
  const customerId = randomUUID();
  const firstName = input.firstName ?? '';
  const lastName = input.lastName ?? '';
  const householdName = [firstName, lastName].filter((part) => part.length > 0).join(' ') || input.email;

  const [, insertedCustomers] = await db.batch([
    db.insert(households).values({ id: householdId, name: `${householdName} Household` }),
    db
      .insert(customers)
      .values({
        id: customerId,
        householdId,
        cognitoSub: input.cognitoSub,
        email: input.email,
        firstName,
        lastName,
        role: 'CUSTOMER',
      })
      .onConflictDoNothing({ target: customers.cognitoSub })
      .returning(),
  ]);

  const insertedCustomer = insertedCustomers[0];
  if (insertedCustomer === undefined) {
    await db.delete(households).where(eq(households.id, householdId));
    const winner = await findCustomerByCognitoSub(input.cognitoSub);
    if (winner === null) {
      throw new Error(
        `provisionCustomerProfile: lost the race for cognitoSub "${input.cognitoSub}" but found no winning row.`,
      );
    }
    return winner;
  }

  await db
    .update(households)
    .set({ primaryCustomerId: customerId })
    .where(eq(households.id, householdId));

  return toCustomer(insertedCustomer);
}

export async function addChild(input: {
  householdId: HouseholdId;
  firstName: string;
  lastName: string;
  dateOfBirth: Date;
  now?: Date;
  tx?: Tx;
}): Promise<Child> {
  const now = input.now ?? new Date();

  const run = async (tx: Tx): Promise<Child> => {
    const householdRows = await tx
      .select()
      .from(households)
      .where(eq(households.id, input.householdId))
      .limit(1);
    if (householdRows[0] === undefined) {
      throw new HouseholdNotFoundError(input.householdId);
    }

    // Re-checked here even though addChildSchema already refuses a future
    // date at the HTTP boundary: this command is also reachable from a seed
    // script, a future kiosk surface, and a test, so the invariant belongs
    // in the domain, not only the schema.
    if (toCalendarDateString(input.dateOfBirth) > toCalendarDateString(now)) {
      throw new InvalidDateOfBirthError(input.dateOfBirth);
    }

    const [inserted] = await tx
      .insert(children)
      .values({
        householdId: input.householdId,
        firstName: input.firstName,
        lastName: input.lastName,
        dateOfBirth: toCalendarDateString(input.dateOfBirth),
      })
      .returning();

    if (inserted === undefined) {
      throw new Error(`addChild: insert into household "${input.householdId}" returned no row.`);
    }

    return {
      id: createChildId(inserted.id),
      householdId: createHouseholdId(inserted.householdId),
      firstName: inserted.firstName,
      lastName: inserted.lastName,
      dateOfBirth: new Date(inserted.dateOfBirth),
      createdAt: inserted.createdAt,
      updatedAt: inserted.updatedAt,
    };
  };

  return input.tx !== undefined ? run(input.tx) : withTransaction(run);
}

export async function updateHousehold(input: {
  householdId: HouseholdId;
  name: string;
  tx?: Tx;
}): Promise<Household & { name: string }> {
  const run = async (tx: Tx): Promise<Household & { name: string }> => {
    // A single guarded UPDATE rather than a read-then-write: it is both
    // atomic and doubles as the existence check via the empty-`returning()`
    // case below.
    const updatedRows = await tx
      .update(households)
      .set({ name: input.name, updatedAt: new Date() })
      .where(eq(households.id, input.householdId))
      .returning();

    const updated = updatedRows[0];
    if (updated === undefined) {
      throw new HouseholdNotFoundError(input.householdId);
    }
    if (updated.primaryCustomerId === null) {
      throw new Error(`updateHousehold: household "${updated.id}" has no primary customer assigned.`);
    }

    return {
      id: createHouseholdId(updated.id),
      primaryCustomerId: createCustomerId(updated.primaryCustomerId),
      name: updated.name,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    };
  };

  return input.tx !== undefined ? run(input.tx) : withTransaction(run);
}

// The only Phase 1 consumer of WaiverProvider — the dependency direction is
// expressed in compiling code even though the body defers to Phase 2.
export function startWaiverSigning(input: {
  waiverProvider: WaiverProvider;
  householdId: HouseholdId;
  participantName: string;
  returnUrl: string;
}): Promise<{ signingUrl: string }> {
  void input;
  return Promise.reject(new NotImplementedInPhase1('startWaiverSigning'));
}
