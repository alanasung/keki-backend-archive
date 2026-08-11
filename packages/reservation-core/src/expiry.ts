import { sql } from 'drizzle-orm';
import { db } from '@keki/database';

const DEFAULT_LIMIT = 500;

// This is what makes HELD safe to sell against at all: a hold consumes a
// seat (drizzle/0002_capacity_constraint.sql), so without this sweep one
// abandoned checkout removes a seat from sale permanently. SC-09.
//
// A single UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED),
// following claimDueNotifications in notification-core/src/outbox.ts:
// select and update stay in one statement so the row lock from the SELECT
// is still held when the UPDATE commits, and SKIP LOCKED means concurrent
// sweeps partition the backlog instead of contending for the same rows.
// Bounded by `limit` — an unbounded UPDATE over a large backlog would time
// the Lambda out mid-statement and roll back the entire sweep.
export async function expireStaleHolds(input: { now?: Date; limit?: number } = {}): Promise<number> {
  const now = input.now ?? new Date();
  const limit = input.limit ?? DEFAULT_LIMIT;

  const result = await db.execute<{ id: string }>(sql`
    UPDATE reservations
    SET status = 'CANCELLED', hold_expires_at = NULL, updated_at = ${now}
    WHERE id IN (
      SELECT id
      FROM reservations
      WHERE status = 'HELD' AND hold_expires_at <= ${now}
      ORDER BY hold_expires_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id
  `);

  return result.rows.length;
}
