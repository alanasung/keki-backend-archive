import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { customers, db, households } from '@keki/database';
import {
  NotImplementedInPhase1,
  type Child,
  type Customer,
  type Household,
  type HouseholdId,
  type WaiverProvider,
} from '@keki/contracts';
import { toCustomer } from './queries';

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

export function addChild(input: {
  householdId: HouseholdId;
  firstName: string;
  lastName: string;
  dateOfBirth: Date;
}): Promise<Child> {
  void input;
  return Promise.reject(new NotImplementedInPhase1('addChild'));
}

export function updateHousehold(input: { householdId: HouseholdId; name: string }): Promise<Household> {
  void input;
  return Promise.reject(new NotImplementedInPhase1('updateHousehold'));
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
