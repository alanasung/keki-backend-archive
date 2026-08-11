# WS-04: catalog-core — catalog cache sync and read paths

## Goal

Create `@keki/catalog-core`, the single read surface the ordering page uses for
both halves of the sellable catalog: cafe items cached from Square, and
published offerings joined to their upcoming occurrences with remaining seat
counts.

Also implement the sync that populates the cache, and wire it into the existing
`scheduled-task-worker` behind a new task key.

Square's Catalog API is deliberately **not** on the render path. Pages read
Postgres, so a Square outage or rate limit degrades freshness rather than taking
the ordering page down.

## Traceability

- **SC-01** — Partially: supplies the cafe-item read path WS-08 renders.
- **SC-02** — Partially: supplies the bookable-occurrence read path including
  `seatsRemaining`.
- **SC-12** — Catalog sync runs on schedule, upserting new items and tombstoning
  removed ones. (The webhook-invalidation half is completed by WS-10; the
  schedule half by WS-11.)

## Dependencies

- **WS-02** — Database (`catalog_items` table).
- **WS-03** — square-client (`listCatalogItems`).

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Module boundaries" and "Data access"; a core package depends on
  the interface, never the vendor SDK
- `docs/vision.md` — "Core Concepts"; Offering and Occurrence definitions
- `packages/database/src/schema/catalog.ts` — `offerings`, `occurrences`, and
  the `catalog_items` table added by WS-02
- `packages/database/src/schema/reservations.ts` — `seat_count` and the status
  values that consume a seat
- `packages/contracts/src/catalog.ts` — `CafeItemView` and
  `BookableOccurrenceView` from WS-01
- `packages/contracts/src/integrations/square.ts` — the `SquareClient` interface
- `packages/reservation-core/src/queries.ts` — `countConfirmedParticipants` and
  its warning that it reports occupancy without enforcing it
- `functions/scheduled-task-worker/src/handler.ts` — the task-key switch this
  workstream extends
- `packages/contracts/src/messages.ts` — `isKnownTaskKey` and the scheduled-task
  message schema

## Package

`packages/catalog-core` (NEW), plus a change to
`functions/scheduled-task-worker`.

## Files Touched

- `packages/catalog-core/package.json` (NEW)
- `packages/catalog-core/tsconfig.json` (NEW)
- `packages/catalog-core/src/index.ts` (NEW)
- `packages/catalog-core/src/sync.ts` (NEW) — `syncCatalog`
- `packages/catalog-core/src/queries.ts` (NEW) — cafe items and bookable
  occurrences
- `packages/catalog-core/src/sync.test.ts` (NEW)
- `packages/catalog-core/src/queries.test.ts` (NEW)
- `packages/catalog-core/src/package-boundaries.test.ts` (NEW)
- `packages/contracts/src/messages.ts` (MODIFY) — add the `catalog.sync` task key
- `functions/scheduled-task-worker/src/handler.ts` (MODIFY) — handle the new key
- `functions/scheduled-task-worker/src/handler.test.ts` (MODIFY)

## Existing Interfaces to Consume

The tables this package reads. `offerings` carries price and capacity;
`occurrences` carries the schedule and an optional capacity override:

```ts
export const offerings = pgTable('offerings', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  type: offeringTypeEnum('type').notNull(),          // 'CLASS' | 'ROOM' | 'OPEN_PLAY'
  durationMinutes: integer('duration_minutes').notNull(),
  defaultCapacity: integer('default_capacity').notNull(),
  priceCents: integer('price_cents').notNull(),
  currency: char('currency', { length: 3 }).notNull().default('USD'),
  status: offeringStatusEnum('status').notNull().default('DRAFT'),
});

export const occurrences = pgTable('occurrences', {
  id: uuid('id').primaryKey().defaultRandom(),
  offeringId: uuid('offering_id').notNull().references(() => offerings.id),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  capacityOverride: integer('capacity_override'),
  status: occurrenceStatusEnum('status').notNull().default('SCHEDULED'),
});
```

The existing occupancy query, whose comment states the boundary this package
must respect — it reports, it does not enforce:

```ts
// Report only — this counts occupancy for display purposes. It enforces no
// capacity limit and must not be mistaken for one; Phase 2 owns the actual
// capacity check (see the TODO in commands.ts on `holdReservation`).
export async function countConfirmedParticipants(occurrenceId: OccurrenceId): Promise<number>;
```

The scheduled-task handler's switch, extended here. Note the exhaustive `never`
default — adding a key without a case is a compile error, which is the point:

```ts
if (!isKnownTaskKey(taskKey)) {
  console.warn(`scheduled-task-worker: unrecognized task key "${taskKey}"; skipping.`);
  continue;
}

switch (taskKey) {
  case 'notification.drain':
    await enqueueNotificationDrain();
    break;
  default: {
    const unhandled: never = taskKey;
    throw new Error(`scheduled-task-worker: unhandled known task key "${String(unhandled)}".`);
  }
}
```

## Implementation Steps

1. **Scaffold the package.** Depends on `@keki/contracts` and `@keki/database`
   only. It must **not** depend on `@keki/square-client` — `syncCatalog`
   receives a `SquareClient` as a parameter, so the dependency direction stays
   interface-only, exactly as `dispatchNotification` receives its providers.

2. **Implement `syncCatalog`** in `sync.ts`:

   ```ts
   export async function syncCatalog(input: {
     squareClient: SquareClient;
     now?: Date;
   }): Promise<{ upserted: number; archived: number; pages: number }>;
   ```

   a. Page through `listCatalogItems`, following the cursor until `null`. Cap
      the loop (e.g. 100 pages) and throw past the cap — an unbounded loop
      against a paginated API is how a Lambda times out silently.

   b. Upsert each variation on the unique `square_variation_id`, updating name,
      description, price, currency, setting `status = 'ACTIVE'`, and stamping
      `syncedAt`. Reactivating on upsert is deliberate: an item removed and
      later restored in Square must come back rather than staying tombstoned.

   c. After a **fully successful** pass, archive rows whose
      `square_variation_id` was not seen: set `status = 'ARCHIVED'`. Never
      delete — `order_line_items` reference these rows.

   d. **Only archive when every page succeeded.** If paging failed partway, the
      unseen set is meaningless and archiving would wipe the menu from a
      transient Square error. Track completeness explicitly and skip the archive
      step otherwise.

   e. Run the upserts and the archive in one transaction so the page never
      observes a half-synced catalog.

3. **Implement `listCafeItems`** in `queries.ts`:

   ```ts
   export async function listCafeItems(): Promise<readonly CafeItemView[]>;
   ```

   Select `status = 'ACTIVE'` rows ordered by name. Archived items must never
   appear.

4. **Implement `listBookableOfferings`** in `queries.ts`:

   ```ts
   export async function listBookableOfferings(input?: {
     from?: Date;
     to?: Date;
     types?: readonly OfferingType[];
   }): Promise<readonly BookableOccurrenceView[]>;
   ```

   Join `occurrences` to `offerings`, filtering to `offerings.status =
   'PUBLISHED'`, `occurrences.status = 'SCHEDULED'`, and `starts_at >= from`
   (defaulting to now). Default `types` to `['CLASS']` — this program sells
   classes only; rooms and open play remain display-only and are out of scope.

   Compute `seatsRemaining` as
   `coalesce(capacity_override, default_capacity) - coalesce(sum(seat_count), 0)`
   over reservations for that occurrence whose status is in
   `('HELD','CONFIRMED','CHECKED_IN')` — **the same status set the WS-02
   trigger counts**. If these two disagree, the page advertises seats the
   database will refuse, or hides seats that are actually free.

   Do this as one aggregate query with a `LEFT JOIN`, not N+1 per occurrence.

   Clamp `seatsRemaining` at zero. An over-subscribed occurrence from a data fix
   should render "sold out", not a negative number.

   Add a header comment stating this value is for display only and is stale on
   return — the authoritative check is the WS-02 trigger, mirroring the existing
   warning on `countConfirmedParticipants`.

5. **Add the `catalog.sync` task key** to `packages/contracts/src/messages.ts`,
   extending the known-task-key union so `isKnownTaskKey` accepts it.

6. **Handle the key** in `scheduled-task-worker`. Add a `case 'catalog.sync'`
   that constructs the real Square client and calls `syncCatalog`. The `never`
   default already forces this case to exist once the key is added.

   The worker is the composition root here: it may import
   `@keki/square-client`, because it is a deployment artifact, not a core
   package.

7. **Log sync outcomes** with counts and page total so the staleness risk in the
   program's risk register is observable in CloudWatch.

8. **Run all four scripts** for both changed packages, then `pnpm -r typecheck`.

## Tests

Database tests are `describe.skipIf(!hasLiveDatabase)`; `syncCatalog` tests use
a stub `SquareClient`.

1. **`syncCatalog` inserts new items** — Stub returns two variations; assert two
   `ACTIVE` rows and `upserted === 2`.
2. **`syncCatalog` updates an existing item** — Change the stub's price; assert
   the row updates rather than duplicating, and `syncedAt` advances.
3. **`syncCatalog` follows the cursor** — Stub returns two pages; assert both
   pages' items land and `pages === 2`.
4. **`syncCatalog` stops at the page cap** — Stub returns an endless cursor;
   assert it throws rather than looping forever.
5. **`syncCatalog` archives items Square no longer returns** — Seed a row, run a
   sync omitting it; assert `status === 'ARCHIVED'` and the row still exists.
6. **A failed page prevents archiving** — Make page 2 reject; assert the call
   fails and no pre-existing row was archived. This is the test that stops a
   transient Square error from wiping the menu.
7. **Archived items reactivate when Square returns them again** — Archive, then
   sync with the item present; assert `ACTIVE`.
8. **`listCafeItems` excludes archived rows** — Assert only `ACTIVE` rows
   return.
9. **`listBookableOfferings` excludes unpublished offerings** — Seed `DRAFT` and
   `PUBLISHED`; assert only the published one returns.
10. **`listBookableOfferings` excludes past occurrences** — Seed one yesterday
    and one tomorrow; assert only tomorrow's returns.
11. **`seatsRemaining` subtracts held and confirmed seats** — Capacity 5, one
    `HELD` (1 seat) and one `CONFIRMED` (2 seats); assert `2`.
12. **`seatsRemaining` ignores cancelled and no-show** — Assert those do not
    consume, matching the WS-02 trigger.
13. **`seatsRemaining` honours `capacity_override`** — Default 2, override 6,
    one seat taken; assert `5`.
14. **`seatsRemaining` clamps at zero** — Over-subscribe; assert `0`, never
    negative.
15. **`seatsRemaining` respects `seat_count`** — One reservation with
    `seat_count = 3` against capacity 5; assert `2`.
16. **Bookable query is not N+1** — Seed 20 occurrences; assert the query count
    is constant (spy on the db client).
17. **`catalog.sync` is a known task key** — Assert `isKnownTaskKey` accepts it.
18. **Worker dispatches `catalog.sync`** — Assert the handler invokes the sync
    path for that key and reports no batch failure.
19. **Unknown keys still log-and-drop** — Assert the existing behavior is
    unchanged.
20. **No Square SDK dependency** — Assert `catalog-core`'s `package.json`
    declares neither `square` nor `@keki/square-client`.

## Acceptance Criteria

1. `packages/catalog-core` and `functions/scheduled-task-worker` pass all four
   scripts, and `pnpm -r typecheck` passes workspace-wide.
2. `catalog-core` depends only on `@keki/contracts` and `@keki/database`;
   `syncCatalog` receives its `SquareClient` by parameter.
3. `syncCatalog` pages via cursor with a hard cap, upserts on
   `square_variation_id`, and archives rather than deletes.
4. Archiving happens **only** after a fully successful pass (test 6).
5. Upsert and archive occur in one transaction.
6. `listCafeItems` returns only `ACTIVE` items.
7. `listBookableOfferings` returns only published offerings with future,
   scheduled occurrences, defaulting to `CLASS`.
8. `seatsRemaining` counts exactly the statuses the WS-02 trigger counts, honours
   `seat_count` and `capacity_override`, and clamps at zero.
9. The bookable query is a single aggregate, not N+1.
10. `seatsRemaining` is documented as display-only and not the capacity check.
11. `catalog.sync` is a known task key handled by the worker's exhaustive switch.
