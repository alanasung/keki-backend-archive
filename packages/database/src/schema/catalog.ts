import { char, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import {
  catalogItemStatusEnum,
  occurrenceStatusEnum,
  offeringStatusEnum,
  offeringTypeEnum,
} from './enums';

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

export const catalogItems = pgTable(
  'catalog_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    squareCatalogObjectId: text('square_catalog_object_id').notNull(),
    // The unique key is the variation, not the item: Square's model has one
    // catalog item with many variations (a latte in two sizes), and the
    // variation is what carries a price and what a customer actually buys.
    // Keying on the item id would collapse sizes into one row.
    squareVariationId: text('square_variation_id').notNull().unique(),
    name: text('name').notNull(),
    description: text('description'),
    priceCents: integer('price_cents').notNull(),
    currency: char('currency', { length: 3 }).notNull().default('USD'),
    status: catalogItemStatusEnum('status').notNull().default('ACTIVE'),
    // Supports the staleness monitoring in the program's risk register —
    // without it there is no way to answer "when did this price last come
    // from Square?"
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('catalog_items_status_idx').on(table.status)],
);
