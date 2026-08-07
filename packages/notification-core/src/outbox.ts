import { eq, sql } from 'drizzle-orm';
import { db, notificationOutbox } from '@keki/database';
import type { CustomerId, NotificationChannel, NotificationStatus } from '@keki/contracts';

// The default retry budget shared by every path that can dead-letter a row.
// reclaimStaleClaims and markNotificationFailed must use the same cap — a
// row's effective retry limit must not depend on *how* it failed.
export const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RECLAIM_WINDOW_MS = 15 * 60 * 1000;
const BASE_RETRY_DELAY_MS = 1000;

function defaultRetryDelayMs(attemptsAfterFailure: number): number {
  return BASE_RETRY_DELAY_MS * 2 ** attemptsAfterFailure;
}

// The row shape every function here reads and writes. `@keki/contracts`'
// `NotificationOutboxEntry` predates the operational lease/retry columns
// (attempts, availableAt, sentAt, lastError — see
// packages/database/src/schema/messaging.ts) that the claim/settle
// functions and WS-11's worker need, so this package defines its own entry
// type covering the full row instead of the contracts one, the same
// divergence reservation-core takes with its local `ReservationRow`.
//
// Written as a plain object type literal (not `$inferSelect`, not an
// `interface`) so it has an implicit index signature and can be used
// directly as the row type for the raw `db.execute(sql...)` claim query
// below, which drizzle-orm's `execute<T extends Record<string, unknown>>`
// requires.
export type NotificationOutboxEntry = {
  readonly id: string;
  readonly channel: NotificationChannel;
  readonly templateKey: string;
  readonly recipientCustomerId: string | null;
  readonly recipientAddress: string;
  readonly payload: Record<string, unknown>;
  readonly status: NotificationStatus;
  readonly attempts: number;
  readonly availableAt: Date;
  readonly claimedAt: Date | null;
  readonly claimedBy: string | null;
  readonly sentAt: Date | null;
  readonly lastError: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

type NotificationOutboxRow = typeof notificationOutbox.$inferSelect;

function toEntry(row: NotificationOutboxRow): NotificationOutboxEntry {
  return {
    ...row,
    payload: row.payload as Record<string, unknown>,
  };
}

export async function enqueueNotification(input: {
  channel: NotificationChannel;
  templateKey: string;
  recipientAddress: string;
  recipientCustomerId?: CustomerId;
  payload: Record<string, unknown>;
  availableAt?: Date;
}): Promise<NotificationOutboxEntry> {
  const [row] = await db
    .insert(notificationOutbox)
    .values({
      channel: input.channel,
      templateKey: input.templateKey,
      recipientAddress: input.recipientAddress,
      ...(input.recipientCustomerId !== undefined
        ? { recipientCustomerId: input.recipientCustomerId }
        : {}),
      payload: input.payload,
      status: 'PENDING',
      attempts: 0,
      ...(input.availableAt !== undefined ? { availableAt: input.availableAt } : {}),
    })
    .returning();

  if (row === undefined) {
    throw new Error('enqueueNotification: insert returned no row.');
  }
  return toEntry(row);
}

// The claim path WS-11's worker and SC-08 depend on. Implemented as a single
// atomic UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)
// statement — not optional. `db` is a neon-http client with no real
// `db.transaction()` (see customer-core's provisionCustomerProfile), and a
// naive select-then-update across two round trips would let two concurrent
// workers claim the same rows and send duplicate messages to real
// customers. Keeping the select and update in one statement keeps them in
// one implicit transaction, so the row lock is still held when the update
// commits.
export async function claimDueNotifications(input: {
  limit: number;
  claimedBy: string;
  now?: Date;
}): Promise<readonly NotificationOutboxEntry[]> {
  const now = input.now ?? new Date();

  const result = await db.execute<NotificationOutboxEntry>(sql`
    UPDATE notification_outbox
    SET status = 'CLAIMED', claimed_at = ${now}, claimed_by = ${input.claimedBy}
    WHERE id IN (
      SELECT id
      FROM notification_outbox
      WHERE status = 'PENDING' AND available_at <= ${now}
      ORDER BY available_at
      LIMIT ${input.limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING
      id,
      channel,
      template_key AS "templateKey",
      recipient_customer_id AS "recipientCustomerId",
      recipient_address AS "recipientAddress",
      payload,
      status,
      attempts,
      available_at AS "availableAt",
      claimed_at AS "claimedAt",
      claimed_by AS "claimedBy",
      sent_at AS "sentAt",
      last_error AS "lastError",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
  `);

  return result.rows;
}

// The companion reaper for rows whose worker died mid-dispatch. CLAIMED is
// non-terminal and row-level locks last only for the claiming transaction,
// so without this a Lambda timeout strands a notification in CLAIMED
// forever — invisible to claimDueNotifications and never dead-lettered.
// Increments `attempts` on every reclaim so a row that repeatedly kills its
// worker eventually reaches DEAD via the same retry budget
// markNotificationFailed uses, rather than cycling indefinitely.
export async function reclaimStaleClaims(input: {
  olderThanMs?: number;
  maxAttempts?: number;
  now?: Date;
}): Promise<number> {
  const olderThanMs = input.olderThanMs ?? DEFAULT_RECLAIM_WINDOW_MS;
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const now = input.now ?? new Date();
  const threshold = new Date(now.getTime() - olderThanMs);

  const result = await db.execute<{ id: string }>(sql`
    UPDATE notification_outbox
    SET
      attempts = attempts + 1,
      status = (CASE WHEN attempts + 1 >= ${maxAttempts} THEN 'DEAD' ELSE 'PENDING' END)::notification_status,
      available_at = CASE WHEN attempts + 1 >= ${maxAttempts} THEN available_at ELSE ${now} END,
      claimed_at = NULL,
      claimed_by = NULL
    WHERE status = 'CLAIMED' AND claimed_at <= ${threshold}
    RETURNING id
  `);

  return result.rows.length;
}

export async function markNotificationSent(input: {
  id: NotificationOutboxEntry['id'];
  sentAt?: Date;
}): Promise<void> {
  await db
    .update(notificationOutbox)
    .set({
      status: 'SENT',
      sentAt: input.sentAt ?? new Date(),
      claimedAt: null,
      claimedBy: null,
    })
    .where(eq(notificationOutbox.id, input.id));
}

export async function markNotificationFailed(input: {
  id: NotificationOutboxEntry['id'];
  error: string;
  maxAttempts?: number;
  retryDelayMs?: number;
}): Promise<void> {
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  const rows = await db
    .select({ attempts: notificationOutbox.attempts })
    .from(notificationOutbox)
    .where(eq(notificationOutbox.id, input.id))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`markNotificationFailed: no notification_outbox row with id "${input.id}".`);
  }

  const nextAttempts = row.attempts + 1;
  const isDead = nextAttempts >= maxAttempts;

  if (isDead) {
    await db
      .update(notificationOutbox)
      .set({
        status: 'DEAD',
        attempts: nextAttempts,
        lastError: input.error,
        claimedAt: null,
        claimedBy: null,
      })
      .where(eq(notificationOutbox.id, input.id));
    return;
  }

  const retryDelayMs = input.retryDelayMs ?? defaultRetryDelayMs(nextAttempts);
  await db
    .update(notificationOutbox)
    .set({
      status: 'PENDING',
      attempts: nextAttempts,
      lastError: input.error,
      claimedAt: null,
      claimedBy: null,
      availableAt: new Date(Date.now() + retryDelayMs),
    })
    .where(eq(notificationOutbox.id, input.id));
}
