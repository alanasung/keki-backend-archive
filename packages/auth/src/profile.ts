import { createCustomerId, createHouseholdId } from '@keki/contracts';
import { customers, db } from '@keki/database';
import { eq } from 'drizzle-orm';
import type { CustomerProfile } from './session';

/** Looks up the Postgres profile joined to a Cognito subject, by the unique `cognito_sub` index. */
export async function findProfileByCognitoSub(cognitoSub: string): Promise<CustomerProfile | null> {
  const rows = await db
    .select({
      id: customers.id,
      householdId: customers.householdId,
      email: customers.email,
      firstName: customers.firstName,
      lastName: customers.lastName,
      role: customers.role,
    })
    .from(customers)
    .where(eq(customers.cognitoSub, cognitoSub))
    .limit(1);

  const row = rows[0];
  if (row === undefined) {
    return null;
  }

  return {
    customerId: createCustomerId(row.id),
    householdId: createHouseholdId(row.householdId),
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    role: row.role,
  };
}
