import { check, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { reservationStatusEnum } from './enums';
import { households, customers, children } from './people';
import { occurrences } from './catalog';
import { waiverRecords } from './compliance';

export const reservations = pgTable(
  'reservations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    occurrenceId: uuid('occurrence_id')
      .notNull()
      .references(() => occurrences.id),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id),
    createdByCustomerId: uuid('created_by_customer_id')
      .notNull()
      .references(() => customers.id),
    status: reservationStatusEnum('status').notNull(),
    holdExpiresAt: timestamp('hold_expires_at', { withTimezone: true }),
    notes: text('notes'),
    // A reservation can hold more than one seat (a parent booking two
    // children); counting rows would undercount. Capacity is enforced by
    // the BEFORE INSERT OR UPDATE trigger in
    // drizzle/0002_capacity_constraint.sql, which sums seat_count across
    // active rows for the occurrence under a row lock.
    seatCount: integer('seat_count').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('reservations_occurrence_id_status_idx').on(table.occurrenceId, table.status),
    index('reservations_occurrence_active_idx')
      .on(table.occurrenceId)
      .where(sql`status in ('HELD', 'CONFIRMED', 'CHECKED_IN')`),
  ],
);

export const reservationParticipants = pgTable(
  'reservation_participants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reservationId: uuid('reservation_id')
      .notNull()
      .references(() => reservations.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id').references(() => customers.id),
    childId: uuid('child_id').references(() => children.id),
    waiverRecordId: uuid('waiver_record_id').references(() => waiverRecords.id),
    checkedInAt: timestamp('checked_in_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Mirrors the discriminated union in @keki/contracts: exactly one of
    // customerId/childId is set. The type system and the database must
    // agree on this invariant.
    check(
      'reservation_participants_exactly_one_participant',
      sql`((${table.customerId} is not null and ${table.childId} is null) or (${table.customerId} is null and ${table.childId} is not null))`,
    ),
  ],
);
