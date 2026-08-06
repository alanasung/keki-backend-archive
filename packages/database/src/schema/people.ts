import {
  customType,
  date,
  pgTable,
  text,
  timestamp,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { roleEnum } from './enums';

// Postgres `citext` (case-insensitive text). Requires `CREATE EXTENSION IF
// NOT EXISTS citext`, hand-added as the first statement of the initial
// migration since drizzle-kit cannot infer extension requirements.
const citext = customType<{ data: string }>({
  dataType() {
    return 'citext';
  },
});

export const households = pgTable('households', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  // References customers.id, declared below. Circular with
  // customers.household_id — drizzle-kit emits this FK as a separate
  // ALTER TABLE statement after both tables exist, so it never blocks
  // table creation order (see AGENTS.md "Data access" and WS-03 spec step 5).
  primaryCustomerId: uuid('primary_customer_id').references((): AnyPgColumn => customers.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const customers = pgTable('customers', {
  id: uuid('id').primaryKey().defaultRandom(),
  householdId: uuid('household_id')
    .notNull()
    .references(() => households.id),
  // Join key to Cognito; WS-04 looks up profiles by it on every
  // authenticated request.
  cognitoSub: text('cognito_sub').notNull().unique(),
  email: citext('email').unique(),
  phone: text('phone'),
  firstName: text('first_name').notNull(),
  lastName: text('last_name').notNull(),
  role: roleEnum('role').notNull().default('CUSTOMER'),
  status: text('status').notNull().default('ACTIVE'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const children = pgTable('children', {
  id: uuid('id').primaryKey().defaultRandom(),
  householdId: uuid('household_id')
    .notNull()
    .references(() => households.id),
  firstName: text('first_name').notNull(),
  lastName: text('last_name').notNull(),
  dateOfBirth: date('date_of_birth').notNull(),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
