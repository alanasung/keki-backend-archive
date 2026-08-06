import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { notificationChannelEnum, notificationStatusEnum } from './enums';
import { customers } from './people';

export const notificationOutbox = pgTable(
  'notification_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channel: notificationChannelEnum('channel').notNull(),
    templateKey: text('template_key').notNull(),
    recipientCustomerId: uuid('recipient_customer_id').references(() => customers.id),
    recipientAddress: text('recipient_address').notNull(),
    payload: jsonb('payload').notNull(),
    status: notificationStatusEnum('status').notNull().default('PENDING'),
    attempts: integer('attempts').notNull().default(0),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    // claimedAt/claimedBy implement the CLAIMED lease state from
    // @keki/contracts. A worker sets both when it takes a row; WS-07's
    // reaper uses claimedAt to reclaim rows abandoned by a crashed
    // invocation.
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    claimedBy: text('claimed_by'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // WS-11's worker claims rows with exactly this predicate.
    index('notification_outbox_status_available_at_idx').on(table.status, table.availableAt),
  ],
);
