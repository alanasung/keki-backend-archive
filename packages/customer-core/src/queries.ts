import { eq } from 'drizzle-orm';
import { children, customers, db, households } from '@keki/database';
import {
  createChildId,
  createCustomerId,
  createHouseholdId,
  type Child,
  type Customer,
  type CustomerId,
  type Household,
  type HouseholdId,
} from '@keki/contracts';

interface CustomerRow {
  id: string;
  householdId: string;
  cognitoSub: string;
  email: string | null;
  firstName: string;
  lastName: string;
  phone: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// `customers.email` has no NOT NULL constraint at the schema level, but every
// row this package writes (via provisionCustomerProfile) always sets one.
export function toCustomer(row: CustomerRow): Customer {
  return {
    id: createCustomerId(row.id),
    householdId: createHouseholdId(row.householdId),
    cognitoSub: row.cognitoSub,
    email: row.email ?? '',
    firstName: row.firstName,
    lastName: row.lastName,
    phone: row.phone,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

interface HouseholdRow {
  id: string;
  primaryCustomerId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// `households.primary_customer_id` is nullable at the schema level to break
// the households/customers insert cycle (see packages/database/src/schema/people.ts),
// but the contract type always requires one. provisionCustomerProfile always
// sets it as the final step of provisioning, so a null here means a household
// row exists that was never finished provisioning.
function toHousehold(row: HouseholdRow): Household {
  if (row.primaryCustomerId === null) {
    throw new Error(`Household ${row.id} has no primary customer assigned.`);
  }
  return {
    id: createHouseholdId(row.id),
    primaryCustomerId: createCustomerId(row.primaryCustomerId),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toChild(row: {
  id: string;
  householdId: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  createdAt: Date;
  updatedAt: Date;
}): Child {
  return {
    id: createChildId(row.id),
    householdId: createHouseholdId(row.householdId),
    firstName: row.firstName,
    lastName: row.lastName,
    dateOfBirth: new Date(row.dateOfBirth),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getCustomerById(id: CustomerId): Promise<Customer | null> {
  const rows = await db.select().from(customers).where(eq(customers.id, id)).limit(1);
  const row = rows[0];
  return row === undefined ? null : toCustomer(row);
}

export async function getHouseholdById(id: HouseholdId): Promise<Household | null> {
  const rows = await db.select().from(households).where(eq(households.id, id)).limit(1);
  const row = rows[0];
  return row === undefined ? null : toHousehold(row);
}

// A narrower sibling to getHouseholdById, for the one case (WS-07's rename
// form) that only ever needed the name: getHouseholdById maps to the
// `Household` contract type, which both omits `name` and throws when
// `primary_customer_id` is null — a real state for any household that
// hasn't finished provisioning. Selecting only `name` sidesteps both.
export async function getHouseholdName(id: HouseholdId): Promise<string | null> {
  const rows = await db.select({ name: households.name }).from(households).where(eq(households.id, id)).limit(1);
  return rows[0]?.name ?? null;
}

export async function listHouseholdMembers(
  householdId: HouseholdId,
): Promise<{ customers: readonly Customer[]; children: readonly Child[] }> {
  const [customerRows, childRows] = await Promise.all([
    db.select().from(customers).where(eq(customers.householdId, householdId)),
    db.select().from(children).where(eq(children.householdId, householdId)),
  ]);

  return {
    customers: customerRows.map(toCustomer),
    children: childRows.map(toChild),
  };
}
