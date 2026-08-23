/**
 * Empties the mutable tables so a suite starts from a known-clean database.
 *
 * A Neon branch is a copy-on-write clone: it inherits the parent's *data*,
 * not just its schema. So `db-branch create` isolates a run from every other
 * run, but the suite still opens on whatever the parent happened to hold —
 * and several integration suites assert on whole-table contents, or clean up
 * with an unqualified `delete from`, which fails the moment an inherited row
 * is referenced by a table further down.
 *
 * Deletes are explicit and FK-ordered. Deliberately **no CASCADE**: a
 * `truncate ... cascade` on `customers` in this project once took out
 * `notification_outbox` through a foreign key and destroyed a parallel
 * suite's data. Naming every table in order makes the blast radius the
 * thing you read, not the thing you discover.
 *
 * `customers` and `households` are kept: `seedTestUsers` is idempotent, the
 * e2e TEST_USERS live there, and every integration suite seeds its own with
 * random ids anyway.
 *
 * Guarded behind KEKI_ALLOW_DB_RESET so this can't be run casually against
 * whatever DATABASE_URL_* happens to be in the environment. `test:isolated`
 * sets it after pointing the environment at a throwaway branch.
 */
import {
  catalogItems,
  children,
  db,
  notificationOutbox,
  occurrences,
  offerings,
  orderLineItems,
  orders,
  paymentRecords,
  playPassLedger,
  playPasses,
  reservationParticipants,
  reservations,
  staffAuditLog,
  waiverRecords,
} from '@keki/database';
import { sql } from 'drizzle-orm';

if (process.env['KEKI_ALLOW_DB_RESET'] !== '1') {
  process.stderr.write(
    'Refusing to run: KEKI_ALLOW_DB_RESET is not set to "1".\n' +
      'This empties every mutable table on whatever DATABASE_URL_POOLED points at.\n' +
      'It is meant to run against a throwaway branch created by scripts/db-branch.ts —\n' +
      'use `pnpm test:isolated`, which sets the variable for you.\n',
  );
  process.exit(1);
}

// Children before parents. play_pass_ledger is append-only (a BEFORE
// UPDATE/DELETE trigger from 0000_even_blob.sql), so a delete there is
// expected to fail if it ever holds rows — reported, not fatal, because
// nothing in this project writes to it yet.
const ORDERED = [
  ['payment_records', paymentRecords],
  ['order_line_items', orderLineItems],
  ['orders', orders],
  ['reservation_participants', reservationParticipants],
  ['reservations', reservations],
  ['occurrences', occurrences],
  ['offerings', offerings],
  ['catalog_items', catalogItems],
  ['notification_outbox', notificationOutbox],
  ['staff_audit_log', staffAuditLog],
  ['play_pass_ledger', playPassLedger],
  ['play_passes', playPasses],
  ['waiver_records', waiverRecords],
  ['children', children],
] as const;

let cleared = 0;
for (const [name, table] of ORDERED) {
  const before = await db.select({ n: sql<number>`count(*)::int` }).from(table as never);
  const count = before[0]?.n ?? 0;
  if (count === 0) continue;
  try {
    await db.delete(table as never);
    cleared += count;
  } catch (error) {
    process.stderr.write(`  ${name}: could not clear ${count} row(s) — ${(error as Error).message.slice(0, 100)}\n`);
  }
}

process.stderr.write(`db-reset: cleared ${cleared} row(s) across ${ORDERED.length} tables\n`);
