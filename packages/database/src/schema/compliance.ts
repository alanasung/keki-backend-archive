import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { waiverStatusEnum } from './enums';
import { children, customers, households } from './people';

export const waiverRecords = pgTable('waiver_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  provider: text('provider').notNull(),
  // Idempotency key for WS-11's webhook handler. Load-bearing, not decorative.
  providerReference: text('provider_reference').notNull().unique(),
  householdId: uuid('household_id')
    .notNull()
    .references(() => households.id),
  customerId: uuid('customer_id').references(() => customers.id),
  childId: uuid('child_id').references(() => children.id),
  signedAt: timestamp('signed_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  documentS3Key: text('document_s3_key'),
  status: waiverStatusEnum('status').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
