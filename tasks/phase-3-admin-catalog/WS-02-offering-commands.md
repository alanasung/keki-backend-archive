# WS-02: catalog-admin — offering create, edit, and guarded status transitions

## Goal

Create `@keki/catalog-admin` and give it the offering write paths: create with
a generated slug, edit, and transition status through the WS-01 table.

This is the first code in the system that can produce a sellable class.
Offerings exist today only because a seed script inserts them.

The package is new rather than an addition to `catalog-core` because
`catalog-core` is the read path the customer ordering page depends on. A
package that serves `/book` should not also carry the ability to archive a
class or change its price.

## Traceability

- **SC-01** — A manager can create a `CLASS` offering with a name,
  description, duration, capacity, and price, saved as `DRAFT`.
- **SC-02** — Offering slugs are generated from the name and stay unique when
  two offerings share a name.
- **SC-03** — Publishing moves `DRAFT → PUBLISHED`, archiving moves to
  `ARCHIVED`, and an undeclared transition is refused.

## Dependencies

- **WS-01** — Contracts (transition table, input schemas).

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Module boundaries" and "Data access"; a core depends on
  `contracts` and `database` only, and all access goes through
  `packages/database`
- `docs/vision.md` — "Core Concepts"; Offering
- `packages/catalog-core/src/queries.ts` — the read paths this package
  deliberately does not touch, and the query style to match
- `packages/database/src/schema/catalog.ts` — the `offerings` table
- `packages/database/src/transaction.ts` — `withTransaction` and `Tx`
- `packages/contracts/src/admin.ts` — WS-01's transitions and schemas
- `packages/commerce-core/src/order-state.ts` — `transitionOrder`, the guarded
  conditional-UPDATE pattern this mirrors

## Package

`packages/catalog-admin` (NEW)

## Files Touched

- `packages/catalog-admin/package.json` (NEW)
- `packages/catalog-admin/tsconfig.json` (NEW)
- `packages/catalog-admin/eslint.config.mjs` (NEW)
- `packages/catalog-admin/src/index.ts` (NEW)
- `packages/catalog-admin/src/errors.ts` (NEW)
- `packages/catalog-admin/src/slug.ts` (NEW)
- `packages/catalog-admin/src/offerings.ts` (NEW)
- `packages/catalog-admin/src/queries.ts` (NEW — admin-side offering reads)
- `packages/catalog-admin/src/slug.test.ts` (NEW)
- `packages/catalog-admin/src/offerings.test.ts` (NEW)
- `packages/catalog-admin/src/package-boundaries.test.ts` (NEW)
- `vitest.workspace.ts` (MODIFY — register the new package)

## Existing Interfaces to Consume

The `offerings` table this package writes:

```ts
export const offerings = pgTable('offerings', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  type: offeringTypeEnum('type').notNull(),
  durationMinutes: integer('duration_minutes').notNull(),
  defaultCapacity: integer('default_capacity').notNull(),
  priceCents: integer('price_cents').notNull(),
  currency: char('currency', { length: 3 }).notNull().default('USD'),
  status: offeringStatusEnum('status').notNull().default('DRAFT'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

The transaction helper. Note its warning about nesting — a caller already
holding a `Tx` must use it rather than opening another:

```ts
export type Tx = Parameters<Parameters<NeonDatabase<typeof schema>['transaction']>[0]>[0];

/**
 * Opens a real Postgres transaction (BEGIN/COMMIT/ROLLBACK), not the
 * neon-http `db`'s single implicit-per-statement kind. Callers that already
 * hold a `Tx` ... should use it directly rather than nesting a new one.
 */
export function withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
```

WS-01's transition table and schemas:

```ts
export const OFFERING_TRANSITIONS: Readonly<Record<OfferingStatus, readonly OfferingStatus[]>> = {
  DRAFT: ['PUBLISHED', 'ARCHIVED'],
  PUBLISHED: ['DRAFT', 'ARCHIVED'],
  ARCHIVED: [],
} as const;

export function canTransitionOffering(from: OfferingStatus, to: OfferingStatus): boolean;
export const createOfferingSchema: z.ZodType<CreateOfferingInput>;
export const updateOfferingSchema: z.ZodType<Partial<CreateOfferingInput>>;
```

The guarded-transition pattern from the previous program — a single
conditional UPDATE, never read-then-write, returning `changed` rather than
throwing on a repeat:

```ts
export async function transitionOrder(input: {
  orderId: OrderId;
  to: OrderStatus;
  expect?: OrderStatus;
  patch?: Partial<Pick<Order, 'squareOrderId' | 'squareCheckoutUrl' | 'providerPaymentId'>>;
}): Promise<{ order: Order; changed: boolean }>;
```

## Implementation Steps

1. **Scaffold the package** per the workspace convention: `main`, `types`, and
   `exports` all point at `./src/index.ts`; `build` is `tsc --noEmit`; all four
   scripts defined. Depends on `@keki/contracts` and `@keki/database` only.

   It must **not** depend on `@keki/catalog-core`. The two are siblings: one
   reads for customers, one writes for staff. A dependency either way invites
   the write path into the customer render path.

   Register it in `vitest.workspace.ts`, or its suites never run under
   `pnpm test` and its coverage is invisible — a vacuous pass.

2. **Add typed errors** in `errors.ts`: `OfferingNotFoundError`,
   `InvalidOfferingTransitionError` (carrying `from` and `to`), and
   `UnsupportedOfferingTypeError`.

3. **Implement slug generation** in `slug.ts`:

   ```ts
   export function slugify(name: string): string;
   export async function generateUniqueSlug(name: string, executor: Tx): Promise<string>;
   ```

   `slugify` lowercases, replaces any run of non-alphanumerics with a single
   hyphen, trims leading and trailing hyphens, and truncates to 80 characters.

   `generateUniqueSlug` queries for existing slugs matching the base or
   `base-<n>` and returns the first free one — `pottery`, then `pottery-2`,
   then `pottery-3`.

   **Take the executor as a parameter and run inside the caller's
   transaction.** Checking uniqueness on a separate connection is a
   time-of-check-to-time-of-use bug: two concurrent creates would both read
   `pottery` as free and the second would fail on the unique constraint. The
   unique index remains the real guarantee — this exists so the common case
   produces a usable slug rather than an error a manager cannot act on.

   If `slugify` yields an empty string (a name of only punctuation), fall back
   to `offering` as the base rather than producing a bare numeric slug.

4. **Implement `createOffering`** in `offerings.ts`:

   ```ts
   export async function createOffering(input: {
     data: CreateOfferingInput;
     actorCustomerId: CustomerId;
     tx?: Tx;
   }): Promise<Offering>;
   ```

   Parse through `createOfferingSchema` even if the caller claims it is
   validated — this function persists catalog state and is reachable from more
   than one caller.

   Inside one transaction: generate the slug (step 3, passing the same
   executor), then insert with `status: 'DRAFT'`.

   Always `DRAFT`, never a caller-supplied status. Creation and publication are
   separate acts; a manager should be able to draft a class without it becoming
   sellable the moment they save.

   Accept an optional `tx` so WS-04 can compose the audit write into the same
   transaction. When absent, open one.

5. **Implement `updateOffering`**:

   ```ts
   export async function updateOffering(input: {
     offeringId: OfferingId;
     data: UpdateOfferingInput;
     actorCustomerId: CustomerId;
     tx?: Tx;
   }): Promise<{ before: Offering; after: Offering }>;
   ```

   Return both states. WS-04 needs the before/after pair for the audit entry,
   and re-reading afterwards on a separate statement could observe a different
   row.

   Do **not** regenerate the slug when the name changes. A slug that moves
   breaks any link already shared; renaming a class is a display change.
   State that in a comment so a later editor does not "fix" it.

   Refuse edits to an `ARCHIVED` offering — it is terminal, and silently
   editing a retired offering is how a stale price returns to sale.

6. **Implement `transitionOffering`**:

   ```ts
   export async function transitionOffering(input: {
     offeringId: OfferingId;
     to: OfferingStatus;
     actorCustomerId: CustomerId;
     tx?: Tx;
   }): Promise<{ offering: Offering; changed: boolean }>;
   ```

   Read the current status and consult `canTransitionOffering`; throw
   `InvalidOfferingTransitionError` on an undeclared edge.

   Perform the write as a **single conditional UPDATE** guarded on the
   status just read — `WHERE id = $1 AND status = $2` — not a read-then-write.
   Two managers publishing at once must not both believe they made the change.

   Return `changed: false` when the offering is already in the target status,
   rather than throwing. A double-clicked publish button should be harmless.

7. **Add admin-side queries** in `queries.ts`: `getOfferingById`, and
   `listOfferings` returning every offering regardless of status, ordered by
   name.

   Deliberately unlike `catalog-core`'s reads, which filter to `PUBLISHED`.
   The admin list must show drafts and archived offerings — they are exactly
   what a manager comes to the page to find.

8. **Run all four scripts** and `pnpm -r typecheck`.

## Tests

Database-touching tests are `describe.skipIf(!hasLiveDatabase)`, matching the
existing integration suites. Follow `commerce-core`'s isolation approach —
per-test `crypto.randomUUID()` identifiers rather than truncation — so this
suite cannot disturb others sharing the CI branch.

1. **`slugify` lowercases and hyphenates** — Assert `'Beginner Pottery'` yields
   `'beginner-pottery'`.
2. **`slugify` collapses punctuation runs** — Assert `'Kids & Clay -- Level 1'`
   yields `'kids-clay-level-1'`, with no doubled or trailing hyphens.
3. **`slugify` truncates long names** — Assert a 200-character name yields at
   most 80 characters and no trailing hyphen.
4. **`slugify` handles a punctuation-only name** — Assert `'!!!'` yields an
   empty string, so step 3's fallback has something to detect.
5. **`generateUniqueSlug` returns the base when free** _(integration)_ — Assert
   `'pottery'`.
6. **`generateUniqueSlug` disambiguates a collision** _(integration)_ — Seed an
   offering with slug `pottery`; assert the next is `pottery-2`, and a third is
   `pottery-3`. **This is SC-02.**
7. **A punctuation-only name still produces a usable slug** _(integration)_ —
   Assert it starts with `offering`, not `-2` or an empty string.
8. **`createOffering` saves as DRAFT** _(integration)_ — Assert the persisted
   status is `'DRAFT'` even though nothing asked for it. **This is SC-01.**
9. **`createOffering` persists every field** _(integration)_ — Assert name,
   description, duration, capacity, and `priceCents` all match the input
   exactly, with price stored as the integer given.
10. **`createOffering` rejects a non-CLASS type** _(integration)_ — Assert a
    `'ROOM'` input fails at parse and inserts nothing.
11. **`createOffering` rejects a supplied status** _(integration)_ — Assert an
    input carrying `status: 'PUBLISHED'` fails and inserts nothing.
12. **`createOffering` is atomic** _(integration)_ — Force the insert to fail
    after slug generation; assert no offering row remains.
13. **`updateOffering` returns before and after** _(integration)_ — Change the
    price; assert `before.priceCents` is the old value and `after.priceCents`
    the new one.
14. **`updateOffering` leaves the slug unchanged on rename** _(integration)_ —
    Rename an offering; assert the slug is byte-identical to before.
15. **`updateOffering` refuses an archived offering** _(integration)_ — Archive,
    then attempt an edit; assert it throws and the row is unchanged.
16. **`transitionOffering` publishes a draft** _(integration)_ — Assert status
    becomes `'PUBLISHED'` and `changed` is `true`. **This is SC-03.**
17. **`transitionOffering` unpublishes** _(integration)_ — Assert
    `PUBLISHED → DRAFT` succeeds, since pulling a class off sale is a
    supported act.
18. **`transitionOffering` archives from either state** _(integration)_ —
    Assert both `DRAFT → ARCHIVED` and `PUBLISHED → ARCHIVED` succeed.
19. **`transitionOffering` refuses an undeclared edge** _(integration)_ —
    Assert `ARCHIVED → PUBLISHED` throws `InvalidOfferingTransitionError`
    carrying both `from` and `to`, and leaves the row unchanged.
20. **`transitionOffering` is idempotent** _(integration)_ — Publish twice;
    assert the second returns `changed: false` and does not throw.
21. **Concurrent publishes produce one change** _(integration)_ — Run two
    `transitionOffering` calls to `PUBLISHED` concurrently on one draft; assert
    exactly one reports `changed: true`. This is what the conditional UPDATE
    exists for; a read-then-write implementation reports two.
22. **`listOfferings` includes drafts and archived** _(integration)_ — Seed one
    of each status; assert all three are returned, unlike `catalog-core`'s
    published-only reads.
23. **No forbidden dependencies** — Assert `package.json` declares no
    `@keki/catalog-core` and no other `*-core` package.
24. **Registered in the vitest workspace** — Assert `vitest.workspace.ts`
    includes `catalog-admin`, so these suites actually run.

## Acceptance Criteria

1. `packages/catalog-admin` passes all four scripts, and `pnpm -r typecheck`
   passes workspace-wide.
2. The package depends only on `@keki/contracts` and `@keki/database`, and is
   registered in `vitest.workspace.ts` (tests 23–24).
3. Slugs are generated, never accepted as input, and disambiguate collisions
   within the caller's transaction (tests 5–7). **SC-02.**
4. `createOffering` always persists `DRAFT`, rejects non-`CLASS` types and
   supplied statuses, and is atomic (tests 8–12). **SC-01.**
5. `updateOffering` returns a before/after pair, never regenerates the slug,
   and refuses archived offerings (tests 13–15).
6. `transitionOffering` honours `OFFERING_TRANSITIONS`, supports unpublishing,
   treats `ARCHIVED` as terminal, and reports `changed` accurately
   (tests 16–20). **SC-03.**
7. The status write is a single conditional UPDATE, proven by the concurrency
   test (test 21).
8. `listOfferings` returns every status, unlike the customer-facing reads.
9. Every command accepts an optional `tx` so WS-04 can compose its audit write
   into the same transaction.
10. Money is handled as integer cents throughout.
