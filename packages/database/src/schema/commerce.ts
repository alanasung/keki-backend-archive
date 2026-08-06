import { char, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { paymentStatusEnum } from './enums';
import { households } from './people';
import { reservations } from './reservations';

export const paymentRecords = pgTable('payment_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  householdId: uuid('household_id')
    .notNull()
    .references(() => households.id),
  reservationId: uuid('reservation_id').references(() => reservations.id),
  provider: text('provider').notNull().default('SQUARE'),
  // Idempotency key for WS-11's webhook handler. Load-bearing, not decorative.
  providerPaymentId: text('provider_payment_id').unique(),
  amountCents: integer('amount_cents').notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  status: paymentStatusEnum('status').notNull(),
  rawPayload: jsonb('raw_payload'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
