# WS-02: Move `recordAuditEntry` from `catalog-admin` to `packages/database`

## Goal

Relocate the audit writer so staff code can use it without depending on the
catalog package.

Phase 3 put `recordAuditEntry` inside `catalog-admin` because that was its only
caller. It is a single-table insert taking a transaction handle — data access,
not catalog domain logic — and `staff-ops` (WS-03) now needs it too. Staff
check-in must not import `@keki/catalog-admin` to write an audit row.

**This is a pure refactor. No behavior changes.** The governing constraint:
Phase 3's audit suite must keep passing, and its **rolled-back-mutation cases
must stay untouched**. Those cases prove SC-11 of the previous program — that
an audit entry never survives a rollback — and they are the single most
valuable thing this move could silently break. (One unrelated assertion in
that file does need a narrow edit; see Implementation Step 4.)

## Traceability

- **SC-12** — Phase 3's audit suite still passes after `recordAuditEntry`
  moves to `packages/database`, with its rolled-back-mutation cases unchanged.
- **SC-10** — Partially: puts the audit writer where both `catalog-admin` and
  `staff-ops` can reach it.

## Dependencies

None. Independent of WS-01 and can run alongside it.

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Data access"; all database access goes through
  `packages/database`
- `docs/vision.md` — "Core Concepts"; the operations/audit surface
- `packages/catalog-admin/src/audit.ts` — the module being moved, in full
- `packages/catalog-admin/src/audit.test.ts` — the suite that must keep
  passing, and whose transaction cases must stay unchanged
- `packages/catalog-admin/src/offerings.ts` — a caller, for the import shape
- `packages/catalog-admin/src/occurrences.ts` — the other caller
- `packages/database/src/transaction.ts` — `withTransaction` and `Tx`, the
  neighbours this joins
- `packages/database/src/index.ts` — the barrel, currently three lines
- `packages/database/src/schema/audit.ts` — the `staff_audit_log` table

## Package

`packages/database` and `packages/catalog-admin`

## Files Touched

- `packages/database/src/audit.ts` (NEW — the relocated writer and diff helper)
- `packages/database/src/index.ts` (MODIFY — export them)
- `packages/database/src/audit.test.ts` (NEW — unit coverage for `changedFields`)
- `packages/catalog-admin/src/audit.ts` (MODIFY — becomes a re-export)
- `packages/catalog-admin/src/index.ts` (MODIFY — barrel unchanged in surface, re-pointed)

## Existing Interfaces to Consume

The module being moved, in full. Both exports go across unchanged:

```ts
import { staffAuditLog, type Tx } from '@keki/database';
import type { AuditAction, AuditEntityType, CustomerId } from '@keki/contracts';

/**
 * `executor` is required, not optional: an optional executor would let a
 * caller omit it and silently get a separate connection, so the entry could
 * commit even when the mutation it describes rolls back (or vice versa).
 * This function never opens a transaction of its own.
 */
export async function recordAuditEntry(input: {
  executor: Tx;
  actorCustomerId: CustomerId;
  action: AuditAction;
  entityType: AuditEntityType;
  entityId: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}): Promise<void>;

export function changedFields<T extends Record<string, unknown>>(
  before: T,
  after: T,
): { before: Partial<T>; after: Partial<T> };
```

The `changedFields` internals that must survive the move exactly — `Date`
comparison by value, and the `updatedAt` exclusion:

```ts
function fieldsEqual(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  return a === b;
}
// ...
for (const key of Object.keys(after) as Array<keyof T>) {
  if (key === 'updatedAt') {
    continue;
  }
  ...
```

The database barrel this joins:

```ts
export { db, schema } from './client';
export * from './schema';
export { withTransaction, type Tx } from './transaction';
```

## Implementation Steps

1. **Move the file** to `packages/database/src/audit.ts` with its contents and
   doc comments intact. Change only the imports: `staffAuditLog` and `Tx`
   become relative (`./schema`, `./transaction`) instead of `@keki/database`,
   which would now be a self-import.

   `@keki/contracts` stays an external import — `packages/database` already
   depends on it for enum values, so this adds no new dependency edge.

2. **Export both from the barrel**, alongside `withTransaction`:

   ```ts
   export { recordAuditEntry, changedFields } from './audit';
   ```

3. **Turn `catalog-admin/src/audit.ts` into a re-export**:

   ```ts
   // Moved to @keki/database in phase-4-staff-surfaces: a single-table insert
   // taking a transaction handle is data access, and staff-ops needs it too
   // without depending on this package. Re-exported here so Phase 3's callers
   // and its audit suite keep working unchanged.
   export { recordAuditEntry, changedFields } from '@keki/database';
   ```

   **Keep this re-export.** It is what lets `offerings.ts`, `occurrences.ts`,
   and `audit.test.ts` stay untouched, and untouched tests are the only real
   evidence the move was faithful. A wholesale import rewrite across
   `catalog-admin` would change the very files whose passing is the proof.

4. **Do not modify the transaction cases in
   `packages/catalog-admin/src/audit.test.ts`.** The rolled-back-mutation cases
   are what prove SC-11 of the previous program, and they must pass untouched.
   If one fails, the move is wrong; fix the move, not the test.

   > **One exception, and only this one.** That file's `audit coverage` test
   > asserts every member of `AUDIT_ACTIONS` appears in `offerings.ts` or
   > `occurrences.ts`. WS-01 adds three `reservation.*` actions that only the
   > staff boundary emits, so the assertion becomes false for reasons that have
   > nothing to do with this refactor. Scoping that one scan to the
   > `offering.`/`occurrence.` prefixes this package actually owns is
   > permitted and expected. Change nothing else in the file.

5. **Add unit coverage for `changedFields`** in `packages/database`. Phase 3
   only exercised it indirectly through integration tests against a live
   database, so its pure logic has never been tested on its own. These run
   without a database.

6. **Verify no import cycle.** `packages/database` must not import
   `@keki/catalog-admin`. Run `pnpm -r typecheck` and confirm the dependency
   direction still flows one way.

7. **Run all four scripts** for both packages, then `pnpm -r typecheck` and
   `pnpm test` workspace-wide.

## Tests

Unit tests for `changedFields` run without a database. The relocated
`recordAuditEntry` is proven by Phase 3's existing integration suite, whose
transaction cases must keep passing unchanged.

1. **`changedFields` returns only changed keys** — Before `{ name: 'A',
   priceCents: 100 }`, after `{ name: 'A', priceCents: 250 }`; assert the
   result is exactly `{ before: { priceCents: 100 }, after: { priceCents: 250 } }`
   and that `name` appears in neither side.
2. **`changedFields` excludes `updatedAt`** — Change only `updatedAt`; assert
   both sides are empty objects. It changes on every write and would appear in
   every entry.
3. **`changedFields` excludes `updatedAt` even alongside a real change** —
   Change `priceCents` and `updatedAt` together; assert the result carries
   `priceCents` and **not** `updatedAt`.
4. **`changedFields` compares `Date` by value, not identity** — Two distinct
   `Date` objects with the same epoch millisecond; assert the field is reported
   as unchanged. Identity comparison would mark every timestamp as changed on
   every write, which is the bug `fieldsEqual` exists to prevent.
5. **`changedFields` reports a genuinely changed `Date`** — Two `Date`s one
   second apart; assert the field **is** reported. This is the discriminating
   half of test 4: an implementation that always returns "unchanged" for dates
   passes test 4 alone.
6. **`changedFields` handles a null-to-value change** — Before `{ notes: null }`,
   after `{ notes: 'x' }`; assert it is reported.
7. **An unchanged row yields two empty objects** — Assert both sides are empty,
   which is what lets a command skip writing an entry for a no-op edit.
8. **`recordAuditEntry` is exported from `@keki/database`** — Assert the import
   resolves and is a function.
9. **`changedFields` is exported from `@keki/database`** — Assert the same.
10. **`@keki/catalog-admin` still exports both** — Import from the
    `catalog-admin` barrel and assert both resolve, proving the re-export keeps
    Phase 3's public surface intact.
11. **The two exports are the same function object** — Assert
    `catalogAdmin.recordAuditEntry === database.recordAuditEntry`. A re-export
    that accidentally became a wrapper or a second copy would pass tests 8–10
    and still be a divergence waiting to happen.
12. **`packages/database` does not depend on `catalog-admin`** — Assert its
    `package.json` declares neither `@keki/catalog-admin` nor
    `@keki/staff-ops`, so the dependency direction cannot invert.
13. **Phase 3's transaction cases are unmodified** — Diff
    `packages/catalog-admin/src/audit.test.ts` against its state at the
    program's start (`git show HEAD:<path>`); assert the only changed hunk is
    the `audit coverage` action-prefix scan, and that every
    rolled-back-mutation case is character-for-character unchanged. **This is
    SC-12**, and it is the only test here that can catch a "fix" that edited
    the evidence instead of the code.
14. **Phase 3's audit suite still passes** _(integration)_ — Run it; assert all
    18 of its cases pass, including the rolled-back-mutation cases that prove
    the entry is inside the transaction rather than beside it.

## Acceptance Criteria

1. `packages/database` and `packages/catalog-admin` pass all four scripts, and
   `pnpm -r typecheck` and `pnpm test` pass workspace-wide.
2. `recordAuditEntry` and `changedFields` are exported from `@keki/database`
   (tests 8–9).
3. `@keki/catalog-admin` re-exports both, and they are the **same function
   objects**, not copies (tests 10–11).
4. `packages/catalog-admin/src/audit.test.ts` passes, and its
   rolled-back-mutation cases are unchanged; the only permitted edit is
   scoping the `audit coverage` scan to the `offering.`/`occurrence.` prefixes
   (tests 13–14). **SC-12.**
5. `offerings.ts` and `occurrences.ts` are not modified — the re-export is what
   makes that possible.
6. `changedFields` has direct unit coverage for the first time, including both
   halves of the `Date`-by-value behavior (tests 1–7).
7. `packages/database` depends on neither `catalog-admin` nor `staff-ops`
   (test 12).
8. No behavior changes. `recordAuditEntry` still takes a **required** executor
   and still opens no transaction of its own.
