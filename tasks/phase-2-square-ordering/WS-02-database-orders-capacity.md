# WS-02: Database — orders, line items, catalog cache, capacity constraint

## Goal

Add the three tables this program needs (`orders`, `order_line_items`,
`catalog_items`) and close the capacity hole Phase 1 deliberately left open on
`reservations`.

The capacity work is the hard part and the reason this workstream is not
trivial. Phase 1 shipped `reservations` with a `TODO(phase-2)` where the
constraint belongs, and `countConfirmedParticipants` explicitly warns it reports
occupancy without enforcing it. Enforcement must land in the database, because
no application-level check can prevent two concurrent transactions both reading
"one seat left" and both inserting.

Schema, migration, and constraint only. No domain logic — WS-05 and WS-06 own
that.

## Traceability

- **SC-03** — Partially: supplies the `orders`/`order_line_items` tables a cart
  is converted into.
- **SC-08** — Partially: supplies the database constraint that makes exactly-one
  winner possible under concurrency. WS-06 proves it.
- **SC-12** — Partially: supplies the `catalog_items` cache table and the
  uniqueness that makes sync an upsert rather than a duplicate insert.
- **SC-19** — Partially: supplies the `order_line_items.reservation_id` column
  and the foreign keys that let one transaction write an order and its holds
  together.

## Dependencies

- **WS-01** — Contracts (the new status arrays back the Drizzle enums, and the
  branded ids back the column types).

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Data access"; all access goes through `packages/database`, and
  application traffic uses the pooled URL while migrations use the direct one
- `docs/vision.md` — "Core Concepts" and the Phase 2+ note that Square is the
  source of truth for money while Postgres owns entitlement
- `packages/database/src/schema/reservations.ts` — the `TODO(phase-2)` marking
  exactly where the capacity constraint belongs
- `packages/database/src/schema/catalog.ts` — `offerings` and `occurrences`,
  including `capacity_override`
- `packages/database/src/schema/commerce.ts` — `payment_records`
- `packages/database/src/schema/enums.ts` — how contract constant arrays become
  `pgEnum`s
- `packages/database/src/schema/index.ts` — the schema barrel
- `packages/database/src/migrate.ts` — the direct-connection migration runner
- `packages/database/drizzle/0000_even_blob.sql` — precedent for hand-written
  additions alongside generated migrations

## Package

`packages/database`

## Files Touched

- `packages/database/src/schema/enums.ts` (MODIFY) — add order, line-item-kind,
  and catalog-item-status enums
- `packages/database/src/schema/orders.ts` (NEW) — `orders`, `order_line_items`
- `packages/database/src/schema/catalog.ts` (MODIFY) — add `catalog_items`
- `packages/database/src/schema/reservations.ts` (MODIFY) — capacity support
  column and index; replace the `TODO(phase-2)`
- `packages/database/src/schema/index.ts` (MODIFY) — export the new tables
- `packages/database/drizzle/0001_chief_gressill.sql` (NEW) — generated migration.
  Name it exactly this. `drizzle-kit generate` assigns a random adjective-noun
  tag, so the name cannot be predicted before generation — but the build
  runner matches declared files **literally**, not as globs, and a wildcard
  here reports the file missing no matter what was produced. If you regenerate
  and get a different tag, rename the file to this one and update
  `drizzle/meta/_journal.json` to match.
- `packages/database/drizzle/0002_capacity_constraint.sql` (NEW) — hand-written
  constraint and trigger
- `packages/database/drizzle/meta/_journal.json` (MODIFY) — register both
  migrations
- `packages/database/drizzle/meta/0001_snapshot.json` (NEW) — generated snapshot
- `packages/database/src/schema/schema.test.ts` (MODIFY) — constraint coverage

## Existing Interfaces to Consume

`reservations` as it stands, including the `TODO` this workstream resolves and
the index Phase 1 added for exactly this query:

```ts
export const reservations = pgTable(
  'reservations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    occurrenceId: uuid('occurrence_id').notNull().references(() => occurrences.id),
    householdId: uuid('household_id').notNull().references(() => households.id),
    createdByCustomerId: uuid('created_by_customer_id').notNull().references(() => customers.id),
    status: reservationStatusEnum('status').notNull(),
    holdExpiresAt: timestamp('hold_expires_at', { withTimezone: true }),
    // TODO(phase-2): capacity enforcement lives here — a partial unique
    // index or exclusion constraint on (occurrence_id) counted against
    // occurrences.capacity_override. Not implemented in Phase 1.
  },
  (table) => [index('reservations_occurrence_id_status_idx').on(table.occurrenceId, table.status)],
);
```

`occurrences`, whose `capacityOverride` falls back to the offering's
`defaultCapacity`:

```ts
export const offerings = pgTable('offerings', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  type: offeringTypeEnum('type').notNull(),
  defaultCapacity: integer('default_capacity').notNull(),
  priceCents: integer('price_cents').notNull(),
  status: offeringStatusEnum('status').notNull().default('DRAFT'),
});

export const occurrences = pgTable('occurrences', {
  id: uuid('id').primaryKey().defaultRandom(),
  offeringId: uuid('offering_id').notNull().references(() => offerings.id),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  capacityOverride: integer('capacity_override'),
  status: occurrenceStatusEnum('status').notNull().default('SCHEDULED'),
});
```

The `CHECK` pattern to mirror for the line-item union — this is the established
precedent, from `reservation_participants`:

```ts
check(
  'reservation_participants_exactly_one_participant',
  sql`((${table.customerId} is not null and ${table.childId} is null) or (${table.customerId} is null and ${table.childId} is not null))`,
),
```

The enum convention:

```ts
export const paymentStatusEnum = pgEnum('payment_status', PAYMENT_STATUSES);
```

## Implementation Steps

1. **Add the three enums** in `enums.ts` from the WS-01 constant arrays:
   `orderStatusEnum`, `orderLineItemKindEnum`, `catalogItemStatusEnum`. Import
   the arrays from `@keki/contracts` — never redeclare the values here, or the
   database and the type system can drift.

2. **Add `catalog_items`** in `catalog.ts`:

   ```ts
   export const catalogItems = pgTable(
     'catalog_items',
     {
       id: uuid('id').primaryKey().defaultRandom(),
       squareCatalogObjectId: text('square_catalog_object_id').notNull(),
       squareVariationId: text('square_variation_id').notNull().unique(),
       name: text('name').notNull(),
       description: text('description'),
       priceCents: integer('price_cents').notNull(),
       currency: char('currency', { length: 3 }).notNull().default('USD'),
       status: catalogItemStatusEnum('status').notNull().default('ACTIVE'),
       syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
       createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
       updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
     },
     (table) => [
       index('catalog_items_status_idx').on(table.status),
     ],
   );
   ```

   `square_variation_id` is the unique key, not `square_catalog_object_id`. In
   Square's model one catalog *item* has many *variations* (a latte in two
   sizes), and the variation is what carries a price and what a customer
   actually buys. Keying on the item id would collapse the sizes into one row
   and lose the price distinction.

   `syncedAt` supports the staleness monitoring named in the program's risk
   register — without it there is no way to answer "when did this price last
   come from Square?"

3. **Add `orders` and `order_line_items`** in a new `orders.ts`:

   ```ts
   export const orders = pgTable(
     'orders',
     {
       id: uuid('id').primaryKey().defaultRandom(),
       householdId: uuid('household_id').notNull().references(() => households.id),
       createdByCustomerId: uuid('created_by_customer_id').notNull().references(() => customers.id),
       status: orderStatusEnum('status').notNull().default('DRAFT'),
       subtotalCents: integer('subtotal_cents').notNull(),
       currency: char('currency', { length: 3 }).notNull().default('USD'),
       squareOrderId: text('square_order_id').unique(),
       squareCheckoutUrl: text('square_checkout_url'),
       providerPaymentId: text('provider_payment_id'),
       expiresAt: timestamp('expires_at', { withTimezone: true }),
       createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
       updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
     },
     (table) => [
       index('orders_household_id_idx').on(table.householdId),
       index('orders_status_expires_at_idx').on(table.status, table.expiresAt),
     ],
   );
   ```

   `square_order_id` is unique so a retried `createCheckout` cannot attach the
   same Square order to two of our orders. The `(status, expires_at)` index
   serves the WS-06 expiry sweep, mirroring how `notification_outbox` indexes
   `(status, available_at)` for its claim query.

   ```ts
   export const orderLineItems = pgTable(
     'order_line_items',
     {
       id: uuid('id').primaryKey().defaultRandom(),
       orderId: uuid('order_id').notNull().references(() => orders.id, { onDelete: 'cascade' }),
       kind: orderLineItemKindEnum('kind').notNull(),
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
       check(
         'order_line_items_kind_matches_target',
         sql`((${table.kind} = 'CATALOG_ITEM' and ${table.catalogItemId} is not null and ${table.occurrenceId} is null) or (${table.kind} = 'OCCURRENCE' and ${table.occurrenceId} is not null and ${table.catalogItemId} is null))`,
       ),
       check('order_line_items_quantity_positive', sql`${table.quantity} > 0`),
       check('order_line_items_unit_price_non_negative', sql`${table.unitPriceCents} >= 0`),
     ],
   );
   ```

   The `kind` check mirrors the WS-01 discriminated union, following the
   `reservation_participants` precedent — the type system and the database must
   agree on the invariant, or one of them is decorative.

   `catalog_item_id` is a plain FK with no cascade: archiving is a status change,
   so a cached row is never deleted out from under a line item.

4. **Add capacity support to `reservations`.** Replace the `TODO(phase-2)`
   comment with a `seatCount` column (`integer`, `not null`, default `1`) and an
   index on `(occurrence_id, status)` — already present — plus a partial index
   supporting the counting query:

   ```ts
   index('reservations_occurrence_active_idx')
     .on(table.occurrenceId)
     .where(sql`status in ('HELD', 'CONFIRMED', 'CHECKED_IN')`),
   ```

   `seatCount` exists because a reservation can hold more than one seat (a
   parent booking two children). Counting rows would undercount.

5. **Write the capacity constraint** as a hand-written migration,
   `drizzle/0002_capacity_constraint.sql`. Drizzle cannot express this, which is
   why it is hand-written alongside the generated file — the same pattern the
   `citext` extension and the `play_pass_ledger` trigger already established.

   Implement a `BEFORE INSERT OR UPDATE` trigger on `reservations` that:

   a. Resolves effective capacity as
      `coalesce(occurrences.capacity_override, offerings.default_capacity)` by
      joining through `occurrences`.

   b. Locks the occurrence row with `SELECT ... FOR UPDATE` before counting.
      **This lock is the entire mechanism.** It serializes concurrent bookings
      for the same occurrence, so the count below cannot be read by two
      transactions simultaneously. Without it the trigger is decorative: both
      transactions read "one seat left" and both insert.

   c. Sums `seat_count` across rows for that occurrence whose status is in
      `('HELD', 'CONFIRMED', 'CHECKED_IN')`, excluding the row being updated.

   d. Raises `exception` with a stable `SQLSTATE` (use `'KEKI1'`) and message
      `capacity_exceeded` when the new total would exceed capacity.

   Statuses `CANCELLED` and `NO_SHOW` do not consume a seat — that is what makes
   a cancellation free the seat without any extra bookkeeping. `HELD` **does**
   consume one, which is what stops two people paying for the last seat; WS-06's
   expiry sweep is what stops an abandoned hold from consuming it forever.

   Use a stable `SQLSTATE` rather than message matching so WS-06 can translate
   the error into a typed domain error without parsing English.

6. **Generate the migration** for steps 1–4 with `pnpm --filter @keki/database
   db:generate`, then add the hand-written `0002` file and register both in
   `drizzle/meta/_journal.json`.

   `drizzle.config.ts` validates `DATABASE_URL_POOLED` / `DATABASE_URL_DIRECT`
   at load, so generation needs those variables **set but not reachable** —
   placeholder values are enough, because generation only diffs the schema
   files and never connects.

   **Do not try to apply the migration locally.** This repository verifies
   migrations in CI: `.github/workflows/ci.yml` creates a per-run Neon branch,
   exports both connection strings, and runs `pnpm db:migrate` before the test
   suite. Production applies them through the tag-triggered deploy workflow.
   There are no local Neon credentials and there should not be, so a local
   apply is not a gate this workstream can or should pass.

   Confirm instead that the generated migration matches the schema files: a
   second `db:generate` must report no schema changes. That catches drift
   without needing a database.

7. **Export the new tables** from `src/schema/index.ts`, and confirm no existing
   import path changed.

## Tests

Every test in this workstream is `describe.skipIf(!hasLiveDatabase)`, matching
`packages/database/src/schema/schema.test.ts`. A constraint cannot be tested
without a database, and a mocked constraint proves nothing.

1. **All three tables exist after migration** — Query `information_schema` for
   `orders`, `order_line_items`, `catalog_items`.
2. **`square_variation_id` is unique** — Insert two catalog rows with the same
   variation id; assert the second violates the unique constraint.
3. **Line-item kind check rejects a mismatch** — Insert `kind = 'CATALOG_ITEM'`
   with `occurrence_id` set; assert the check fires. Repeat inverted.
4. **Line-item kind check rejects both-null** — Insert `kind = 'CATALOG_ITEM'`
   with `catalog_item_id` null; assert rejection.
5. **Quantity must be positive** — Assert `quantity = 0` is rejected.
6. **Deleting an order cascades its line items** — Assert the cascade fires and
   leaves no orphans.
7. **Capacity trigger allows booking up to capacity** — Seed an occurrence with
   capacity 3; insert reservations summing to 3 seats; assert all succeed.
8. **Capacity trigger rejects the seat past capacity** — Insert a 4th seat;
   assert it raises `SQLSTATE 'KEKI1'`.
9. **`seat_count` is respected, not row count** — Seed capacity 3; insert one
   reservation with `seat_count = 3`; assert a further 1-seat insert is
   rejected.
10. **`capacity_override` wins over `default_capacity`** — Offering default 2,
    override 5; assert 5 seats are accepted.
11. **Cancelled reservations free their seat** — Fill capacity, cancel one,
    assert a new booking succeeds.
12. **`HELD` consumes a seat** — Fill capacity with `HELD` rows; assert a
    `CONFIRMED` insert is rejected. This is the test that proves a hold actually
    reserves.
13. **Concurrent inserts cannot oversell** _(integration)_ — Seed a one-seat
    occurrence; run two inserting transactions concurrently; assert exactly one
    commits and the other raises `KEKI1`. This is the test that proves the
    `FOR UPDATE` lock in step 5b is present and correct; without the lock this
    test fails while tests 7–12 still pass.
14. **Updating a reservation's status does not double-count** — Move a row from
    `HELD` to `CONFIRMED` at exactly capacity; assert it succeeds, proving the
    "excluding the row being updated" clause works.
15. **`orders.square_order_id` is unique** — Assert a duplicate is rejected.

## Acceptance Criteria

1. `packages/database` passes all four scripts.
2. Both migrations exist and are registered in `drizzle/meta/_journal.json`, and
   a second `db:generate` reports no schema changes — so the checked-in SQL
   matches the schema files with no drift. Applying against Neon is CI's job
   (per-run branch, then `pnpm db:migrate`) and is **not** a local gate.
3. `orders`, `order_line_items`, and `catalog_items` exist with the columns,
   indexes, and checks above.
4. `order_line_items` enforces the catalog-item XOR occurrence invariant in the
   database, not only in TypeScript.
5. The `TODO(phase-2)` capacity comment in `reservations.ts` is **removed** and
   replaced by the real constraint.
6. Capacity is enforced by a trigger that takes a row lock on the occurrence
   before counting, and concurrency test 13 passes.
7. The capacity error raises a stable `SQLSTATE 'KEKI1'` so callers need not
   match on message text.
8. `HELD`, `CONFIRMED`, and `CHECKED_IN` consume seats; `CANCELLED` and
   `NO_SHOW` do not.
9. Effective capacity resolves `capacity_override` before `default_capacity`.
10. No domain logic is added to `packages/database` — schema, migrations, and
    constraints only.
