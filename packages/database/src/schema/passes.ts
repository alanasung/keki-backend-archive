import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { ledgerReasonEnum } from './enums';
import { customers, households } from './people';
import { offerings } from './catalog';
import { reservations } from './reservations';

export const playPasses = pgTable('play_passes', {
  id: uuid('id').primaryKey().defaultRandom(),
  householdId: uuid('household_id')
    .notNull()
    .references(() => households.id),
  offeringId: uuid('offering_id').references(() => offerings.id),
  totalCredits: integer('total_credits').notNull(),
  remainingCredits: integer('remaining_credits').notNull(),
  purchasedAt: timestamp('purchased_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  status: text('status').notNull().default('ACTIVE'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Append-only: correct by writing a compensating entry, never by editing a
// row (AGENTS.md "Data access"). Enforced at the database level by a
// BEFORE UPDATE OR DELETE trigger, hand-added to the generated migration —
// see WS-03 spec step 8.
export const playPassLedger = pgTable(
  'play_pass_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    playPassId: uuid('play_pass_id')
      .notNull()
      .references(() => playPasses.id),
    deltaCredits: integer('delta_credits').notNull(),
    reason: ledgerReasonEnum('reason').notNull(),
    reservationId: uuid('reservation_id').references(() => reservations.id),
    actorCustomerId: uuid('actor_customer_id').references(() => customers.id),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Balance reconstruction reads the ledger in order.
    index('play_pass_ledger_play_pass_id_occurred_at_idx').on(table.playPassId, table.occurredAt),
  ],
);
