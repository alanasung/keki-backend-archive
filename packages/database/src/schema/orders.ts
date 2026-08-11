import { check, char, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { orderLineItemKindEnum, orderStatusEnum } from './enums';
import { households, customers } from './people';
import { catalogItems, occurrences } from './catalog';
import { reservations } from './reservations';

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id),
    createdByCustomerId: uuid('created_by_customer_id')
      .notNull()
      .references(() => customers.id),
    status: orderStatusEnum('status').notNull().default('DRAFT'),
    subtotalCents: integer('subtotal_cents').notNull(),
    currency: char('currency', { length: 3 }).notNull().default('USD'),
    // Unique so a retried createCheckout cannot attach the same Square
    // order to two of our orders.
    squareOrderId: text('square_order_id').unique(),
    squareCheckoutUrl: text('square_checkout_url'),
    providerPaymentId: text('provider_payment_id'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('orders_household_id_idx').on(table.householdId),
    // Serves WS-06's expiry sweep, mirroring how notification_outbox
    // indexes (status, available_at) for its claim query.
    index('orders_status_expires_at_idx').on(table.status, table.expiresAt),
  ],
);

export const orderLineItems = pgTable(
  'order_line_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    kind: orderLineItemKindEnum('kind').notNull(),
    // Plain FK with no cascade: archiving a catalog item is a status
    // change, so a cached row is never deleted out from under a line item.
    catalogItemId: uuid('catalog_item_id').references(() => catalogItems.id),
    occurrenceId: uuid('occurrence_id').references(() => occurrences.id),
    reservationId: uuid('reservation_id').references(() => reservations.id),
    quantity: integer('quantity').notNull(),
    unitPriceCents: integer('unit_price_cents').notNull(),
    nameSnapshot: text('name_snapshot').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('order_line_items_order_id_idx').on(table.orderId),
    // Mirrors the WS-01 discriminated union, following the
    // reservation_participants precedent: the type system and the database
    // must agree on the invariant, or one of them is decorative.
    check(
      'order_line_items_kind_matches_target',
      sql`((${table.kind} = 'CATALOG_ITEM' and ${table.catalogItemId} is not null and ${table.occurrenceId} is null) or (${table.kind} = 'OCCURRENCE' and ${table.occurrenceId} is not null and ${table.catalogItemId} is null))`,
    ),
    check('order_line_items_quantity_positive', sql`${table.quantity} > 0`),
    check('order_line_items_unit_price_non_negative', sql`${table.unitPriceCents} >= 0`),
  ],
);
