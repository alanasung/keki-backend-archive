import { char, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { occurrenceStatusEnum, offeringStatusEnum, offeringTypeEnum } from './enums';

export const offerings = pgTable('offerings', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  type: offeringTypeEnum('type').notNull(),
  durationMinutes: integer('duration_minutes').notNull(),
  defaultCapacity: integer('default_capacity').notNull(),
  priceCents: integer('price_cents').notNull(),
  currency: char('currency', { length: 3 }).notNull().default('USD'),
  status: offeringStatusEnum('status').notNull().default('DRAFT'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const occurrences = pgTable(
  'occurrences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    offeringId: uuid('offering_id')
      .notNull()
      .references(() => offerings.id),
    // Always timestamptz — a cafe with scheduled programming across DST
    // boundaries will produce wrong answers with a bare timestamp.
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    capacityOverride: integer('capacity_override'),
    status: occurrenceStatusEnum('status').notNull().default('SCHEDULED'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The staff "today" view and the customer booking calendar both query
    // by date range.
    index('occurrences_starts_at_idx').on(table.startsAt),
    index('occurrences_offering_id_starts_at_idx').on(table.offeringId, table.startsAt),
  ],
);
