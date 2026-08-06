import { inet, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { customers } from './people';

export const staffAuditLog = pgTable('staff_audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  actorCustomerId: uuid('actor_customer_id')
    .notNull()
    .references(() => customers.id),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: uuid('entity_id').notNull(),
  before: jsonb('before'),
  after: jsonb('after'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  ipAddress: inet('ip_address'),
});
