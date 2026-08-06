import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    // TODO(phase-2): capacity enforcement lives here — a partial unique
    // index or exclusion constraint on (occurrence_id) counted against
    // occurrences.capacity_override. Not implemented in Phase 1.
  },
  (table) => [index('reservations_occurrence_id_status_idx').on(table.occurrenceId, table.status)],
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
