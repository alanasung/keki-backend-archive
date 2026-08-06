# WS-03: Database — Drizzle schema, migrations, dual connections

## Goal

Create `@keki/database`: Drizzle table definitions for all thirteen entities,
generated migrations that apply cleanly against a Neon branch, and the
pooled/direct connection split. This package is the only place in the repository
that opens a database connection or writes SQL.

Reservation capacity logic is explicitly **not** implemented here. The tables
that will eventually carry capacity constraints are shaped for the known access
patterns and marked `TODO(phase-2)`.

## Traceability

- **SC-03** — Neon migrations run successfully using the direct connection string.
- **SC-10** — All thirteen Drizzle tables exist with generated, applied migrations.
- **SC-13** — Application traffic uses the pooled connection string and migrations use the direct one, configured as separate secrets.
- **SC-06** — The package compiles independently.

## Dependencies

- **WS-02** — Contracts (entity types and enums this schema must match).

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Data access" convention; note the pooled/direct rule and the append-only ledger rule
- `docs/vision.md` — sections "Data Model" and "Core Concepts"
- `packages/contracts/src/entities.ts` — the entity types and enum tuples this schema must mirror
- `packages/contracts/src/ids.ts` — branded ID types
- `tsconfig.base.json`

## Package

`packages/database` — published internally as `@keki/database`.

## Files Touched

- `packages/database/package.json` (NEW)
- `packages/database/tsconfig.json` (NEW)
- `packages/database/drizzle.config.ts` (NEW)
- `packages/database/src/index.ts` (NEW) — barrel
- `packages/database/src/client.ts` (NEW) — pooled connection for app traffic
- `packages/database/src/migrate.ts` (NEW) — direct connection, migration runner
- `packages/database/src/env.ts` (NEW) — connection string resolution
- `packages/database/src/schema/enums.ts` (NEW)
- `packages/database/src/schema/people.ts` (NEW) — households, customers, children
- `packages/database/src/schema/catalog.ts` (NEW) — offerings, occurrences
- `packages/database/src/schema/reservations.ts` (NEW) — reservations, reservation_participants
- `packages/database/src/schema/passes.ts` (NEW) — play_passes, play_pass_ledger
- `packages/database/src/schema/compliance.ts` (NEW) — waiver_records
- `packages/database/src/schema/commerce.ts` (NEW) — payment_records
- `packages/database/src/schema/messaging.ts` (NEW) — notification_outbox
- `packages/database/src/schema/audit.ts` (NEW) — staff_audit_log
- `packages/database/src/schema/index.ts` (NEW) — schema barrel with relations
- `packages/database/drizzle/` (NEW) — generated migration SQL and journal
- `packages/database/src/schema/schema.test.ts` (NEW)
- `packages/database/src/env.test.ts` (NEW)

## Existing Interfaces to Consume

From `@keki/contracts` (WS-02). The schema's enum values must be generated from
these tuples rather than retyped, so the two cannot drift:

```ts
export const ROLES = ['CUSTOMER', 'FRONT_OF_HOUSE', 'MANAGER', 'ADMIN'] as const;
export type Role = (typeof ROLES)[number];

export const OFFERING_TYPES = ['CLASS', 'ROOM', 'OPEN_PLAY'] as const;
export const OFFERING_STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;
export const OCCURRENCE_STATUSES = ['SCHEDULED', 'CANCELLED', 'COMPLETED'] as const;
export const RESERVATION_STATUSES = [
  'HELD',
  'CONFIRMED',
  'CHECKED_IN',
  'CANCELLED',
  'NO_SHOW',
] as const;
export const LEDGER_REASONS = ['PURCHASE', 'REDEMPTION', 'ADJUSTMENT', 'EXPIRY', 'REFUND'] as const;
export const PAYMENT_STATUSES = [
  'PENDING',
  'AUTHORIZED',
  'CAPTURED',
  'REFUNDED',
  'FAILED',
] as const;
export const NOTIFICATION_CHANNELS = ['EMAIL', 'SMS', 'MARKETING'] as const;
export const NOTIFICATION_STATUSES = ['PENDING', 'CLAIMED', 'SENT', 'FAILED', 'DEAD'] as const;
export const WAIVER_STATUSES = ['SIGNED', 'EXPIRED', 'REVOKED'] as const;
```

Drizzle's `pgEnum` accepts a readonly tuple directly:

```ts
import { pgEnum } from 'drizzle-orm/pg-core';
import { ROLES } from '@keki/contracts';

export const roleEnum = pgEnum('role', ROLES);
```

## Implementation Steps

1. **Scaffold the package.** Dependencies: `drizzle-orm`,
   `@neondatabase/serverless`, `@keki/contracts`. Dev dependencies:
   `drizzle-kit`, `vitest`, `typescript`, `dotenv`.

2. **Resolve connection strings** in `src/env.ts`. Two distinct variables, never
   interchanged:

   - `DATABASE_URL_POOLED` — Neon pooled endpoint (`-pooler` host). Used by
     `client.ts` for all application traffic.
   - `DATABASE_URL_DIRECT` — Neon direct endpoint. Used **only** by
     `migrate.ts` and `drizzle.config.ts`.

   Validate both with a Zod schema at module load and fail loudly with a message
   naming the missing variable. Additionally assert that the pooled URL host
   contains `-pooler` and the direct URL host does not, and throw if they are
   swapped. This check is cheap and catches the single most likely production
   misconfiguration: DDL run through the connection pooler, which fails in
   confusing ways.

3. **Create the pooled client** in `src/client.ts` using
   `drizzle-orm/neon-http` (or `neon-serverless` if transactions are needed)
   with `DATABASE_URL_POOLED`. Export a single `db` instance and the `schema`
   object. Do not export the raw driver — `AGENTS.md` requires all access to go
   through this package.

4. **Define enums** in `src/schema/enums.ts`, one `pgEnum` per contracts tuple,
   as shown above. Import the tuples; never retype the string literals.

5. **Define the people tables** in `src/schema/people.ts`:
   - `households` — `id` uuid PK default `gen_random_uuid()`, `name`,
     `primary_customer_id` uuid nullable, timestamps.
   - `customers` — `id`, `household_id` FK → households, `cognito_sub` text
     **unique not null**, `email` citext unique, `phone`, `first_name`,
     `last_name`, `role` roleEnum not null default `'CUSTOMER'`, `status`,
     timestamps.
   - `children` — `id`, `household_id` FK, `first_name`, `last_name`,
     `date_of_birth` date, `notes`, timestamps.

   `cognito_sub` is the join key to Cognito and must be unique and indexed;
   WS-04 looks up profiles by it on every authenticated request.

   Resolve the `households.primary_customer_id` ↔ `customers.household_id`
   circular reference by declaring the FK constraint in a later migration step
   or as `DEFERRABLE INITIALLY DEFERRED`. Do not let it block table creation
   order.

6. **Define the catalog tables** in `src/schema/catalog.ts`:
   - `offerings` — `id`, `slug` unique, `name`, `description`, `type`
     offeringTypeEnum, `duration_minutes` integer, `default_capacity` integer,
     `price_cents` integer, `currency` char(3) default `'USD'`, `status`
     offeringStatusEnum, timestamps.
   - `occurrences` — `id`, `offering_id` FK, `starts_at` timestamptz not null,
     `ends_at` timestamptz not null, `capacity_override` integer nullable,
     `status` occurrenceStatusEnum, timestamps. Index on
     `(starts_at)` and on `(offering_id, starts_at)` — the staff "today" view
     and the customer booking calendar both query by date range.

   All timestamps are `timestamptz`. Never use `timestamp` without a time zone;
   a cafe with scheduled programming across DST boundaries will produce wrong
   answers.

7. **Define the reservation tables** in `src/schema/reservations.ts`:
   - `reservations` — `id`, `occurrence_id` FK, `household_id` FK,
     `created_by_customer_id` FK → customers, `status` reservationStatusEnum,
     `hold_expires_at` timestamptz nullable, `notes`, timestamps. Index on
     `(occurrence_id, status)`.
   - `reservation_participants` — `id`, `reservation_id` FK on delete cascade,
     `customer_id` FK nullable, `child_id` FK nullable, `waiver_record_id` FK
     nullable, `checked_in_at` timestamptz nullable, `created_at`.

   Add a `CHECK` constraint enforcing that exactly one of `customer_id` and
   `child_id` is non-null, mirroring the discriminated union in contracts. The
   type system and the database must agree on this invariant.

   **Add `TODO(phase-2)` comments** where capacity enforcement will live — a
   partial unique index or exclusion constraint on `(occurrence_id)` counted
   against `occurrences.capacity_override`. Do not implement it.

8. **Define the pass tables** in `src/schema/passes.ts`:
   - `play_passes` — `id`, `household_id` FK, `offering_id` FK nullable,
     `total_credits` integer, `remaining_credits` integer, `purchased_at`,
     `expires_at` nullable, `status`, timestamps.
   - `play_pass_ledger` — `id`, `play_pass_id` FK, `delta_credits` integer not
     null, `reason` ledgerReasonEnum, `reservation_id` FK nullable,
     `actor_customer_id` FK nullable, `occurred_at` timestamptz not null
     default now, `metadata` jsonb, `created_at`.

   **The ledger is append-only.** Enforce it in the database, not by convention:
   create a `BEFORE UPDATE OR DELETE` trigger on `play_pass_ledger` that raises
   an exception. Add this as a hand-written statement in the generated migration.
   `AGENTS.md` states the rule; this is where it becomes true.

   Index `(play_pass_id, occurred_at)` — balance reconstruction reads the
   ledger in order.

9. **Define compliance, commerce, messaging, and audit tables** in their
   respective files:
   - `waiver_records` — `id`, `provider` text, `provider_reference` text
     **unique**, `household_id` FK, `customer_id` FK nullable, `child_id` FK
     nullable, `signed_at`, `expires_at` nullable, `document_s3_key` text
     nullable, `status` waiverStatusEnum, `created_at`.
   - `payment_records` — `id`, `household_id` FK, `reservation_id` FK nullable,
     `provider` text default `'SQUARE'`, `provider_payment_id` text **unique**,
     `amount_cents` integer, `currency` char(3), `status` paymentStatusEnum,
     `raw_payload` jsonb, `occurred_at`, timestamps.
   - `notification_outbox` — `id`, `channel` notificationChannelEnum,
     `template_key` text, `recipient_customer_id` FK nullable,
     `recipient_address` text, `payload` jsonb, `status`
     notificationStatusEnum default `'PENDING'`, `attempts` integer default 0,
     `available_at` timestamptz default now, `claimed_at` timestamptz nullable,
     `claimed_by` text nullable, `sent_at` nullable, `last_error`
     text nullable, timestamps. Index on `(status, available_at)` — the WS-11
     worker claims rows with exactly this predicate.

     `claimed_at` and `claimed_by` implement the `CLAIMED` lease state from
     `@keki/contracts`. A worker sets both when it takes a row; WS-07's reaper
     uses `claimed_at` to reclaim rows abandoned by a crashed invocation. Without
     the lease columns, `CLAIMED` records that a row was taken but not by whom
     or when, so a stuck row is stuck forever.

   - `staff_audit_log` — `id`, `actor_customer_id` FK, `action` text,
     `entity_type` text, `entity_id` uuid, `before` jsonb, `after` jsonb,
     `occurred_at`, `ip_address` inet nullable.

   The unique constraints on `provider_reference` and `provider_payment_id` are
   the idempotency keys for WS-11's webhook handler. They are load-bearing, not
   decorative.

10. **Declare relations** in `src/schema/index.ts` using Drizzle's `relations()`
    helper, and re-export every table. Relations are needed for typed joins in
    Phase 2 and cost nothing now.

11. **Configure drizzle-kit** in `drizzle.config.ts` with
    `dialect: 'postgresql'`, `schema: './src/schema/index.ts'`,
    `out: './drizzle'`, and credentials from `DATABASE_URL_DIRECT`. Never the
    pooled URL — DDL through a pooler is the failure mode step 2 guards against.

12. **Generate the migration.** Run `pnpm drizzle-kit generate`. Then
    hand-edit the generated SQL to add the three statements drizzle-kit cannot
    infer:

    - `CREATE EXTENSION IF NOT EXISTS citext;` as the **first** statement.
      `customers.email` is a `citext` column, and on a clean Neon branch the
      extension does not exist, so without this the very first migration fails
      and SC-03 is unreachable.
    - The `reservation_participants` `CHECK` constraint.
    - The `play_pass_ledger` append-only trigger.

    Commit the generated `drizzle/` directory including its
    `meta/_journal.json`.

13. **Write the migration runner** in `src/migrate.ts` using
    `drizzle-orm/neon-serverless/migrator` against `DATABASE_URL_DIRECT`. Add a
    `db:migrate` script to the package and a root-level passthrough.

14. **Apply against a real Neon branch** and confirm all thirteen tables exist.
    This is SC-03; a migration that only generates is not a migration that runs.

15. **Verify.** Run all four package scripts plus `db:migrate`.

## Tests

Schema-shape tests run without a database by introspecting the Drizzle objects.
Cases 8–10 require a Neon branch and run as integration tests.

1. **All thirteen tables are exported** — Assert the schema barrel exports
   exactly the thirteen expected table objects, by name.
2. **Enums match contracts** — For each `pgEnum`, assert its value list is
   identical (same members, same order) to the corresponding tuple exported from
   `@keki/contracts`. This is the drift guard for step 4.
3. **Every timestamp column is timezone-aware** — Introspect all table columns
   whose type is a timestamp; assert each has `withTimezone: true`.
4. **Money columns are integers** — Assert `offerings.price_cents` and
   `payment_records.amount_cents` are integer columns, not numeric or real.
5. **Idempotency keys are unique** — Assert unique constraints exist on
   `customers.cognito_sub`, `waiver_records.provider_reference`, and
   `payment_records.provider_payment_id`.
6. **Outbox index supports the worker predicate** — Assert an index exists on
   `notification_outbox` covering `(status, available_at)`.
7. **Env validation rejects swapped URLs** — Call the `env.ts` resolver with a
   pooled URL in `DATABASE_URL_DIRECT` and a direct URL in
   `DATABASE_URL_POOLED`; assert it throws, and that the message names both
   variables. Also assert it throws when either variable is absent.
8. **Migrations apply to an empty database** _(integration)_ — Against a clean
   Neon branch, run the migration runner; assert exit 0 and that
   `information_schema.tables` contains all thirteen table names.
9. **Ledger rejects UPDATE and DELETE** _(integration)_ — Insert a
   `play_pass_ledger` row, then attempt an `UPDATE` and a `DELETE`. Assert both
   raise a database exception and the row is unchanged. This is the test that
   proves the append-only rule is enforced rather than merely documented.
10. **Participant CHECK constraint holds** _(integration)_ — Assert inserting a
    `reservation_participants` row with both `customer_id` and `child_id` set
    fails, inserting with neither set fails, and inserting with exactly one set
    succeeds.

## Acceptance Criteria

1. `packages/database` compiles, lints, tests, and builds via all four scripts.
2. All thirteen tables are defined and exported, matching the names in
   `docs/vision.md` § Data Model.
3. `pnpm --filter @keki/database db:migrate` applies cleanly to an empty Neon
   branch and creates all thirteen tables.
4. `drizzle.config.ts` and `src/migrate.ts` use `DATABASE_URL_DIRECT`;
   `src/client.ts` uses `DATABASE_URL_POOLED`. No file uses both.
5. `src/env.ts` throws when either variable is missing or when the two are
   swapped.
6. `play_pass_ledger` has a database-level trigger that rejects `UPDATE` and
   `DELETE`, verified by integration test 9.
7. `reservation_participants` has a `CHECK` constraint enforcing exactly one of
   `customer_id` / `child_id`, verified by integration test 10.
8. Every `pgEnum` derives its values from a `@keki/contracts` tuple; no enum
   member string is retyped in this package.
9. Every timestamp column is `timestamptz`.
10. The generated `drizzle/` directory, including `meta/_journal.json`, is
    committed.
11. No reservation capacity constraint is implemented; the intended location is
    marked with a `TODO(phase-2)` comment.
12. No file outside this package opens a database connection.
