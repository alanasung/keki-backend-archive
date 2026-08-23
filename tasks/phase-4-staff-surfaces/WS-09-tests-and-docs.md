# WS-09: Tests, e2e coverage, and documentation

## Goal

Close the program with the coverage that only makes sense once every piece
exists: a Playwright journey proving a staff member can see today's schedule,
check a participant in, and watch the occupancy count change — and
documentation of the staff surface.

The journey is the point. Every other workstream verifies its own piece; this
one verifies that the pieces connect — that a tap on `/staff/check-in` writes a
timestamp that `/staff/occupancy` reads back. That is the program's whole
claim.

## Traceability

- **SC-17** — Playwright covers a staff journey: view today, check a
  participant in, and see occupancy reflect them.
- **SC-01** — Partially: asserts today's schedule renders against real seeded
  data rather than mocks.
- **SC-11** — Partially: asserts the staff audit integration suites are not
  silently skipped in CI.

## Dependencies

- **WS-06** — `/staff/today`.
- **WS-07** — `/staff/check-in`.
- **WS-08** — `/staff/occupancy`.

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Testing" and "Delivery"
- `docs/vision.md` — "Target Users"; the Front of house persona
- `docs/testing.md` — the existing strategy and the skip audit this extends
- `apps/web/e2e/admin-catalog.spec.ts` — Phase 3's journey, the spec to mirror,
  including its per-run unique naming
- `apps/web/e2e/fixtures/seed.ts` — `TEST_USERS` (including the seeded
  `FRONT_OF_HOUSE` user, unused until now) and the ordering fixtures
- `apps/web/e2e/fixtures/session.ts` — `createRoleContext`
- `scripts/assert-integration-tests-ran.ts` — the skip audit and
  `REQUIRED_INTEGRATION_SUITES`
- `vitest.workspace.ts` — where `staff-ops` must be registered
- `docs/as-built.md` — the snapshot to bring current

## Package

`apps/web`, plus workspace-level test configuration and docs.

## Files Touched

- `apps/web/e2e/staff-check-in.spec.ts` (NEW — the today-to-occupancy journey)
- `apps/web/e2e/fixtures/seed.ts` (MODIFY — seed a today occurrence with confirmed participants)
- `apps/web/e2e/routes.spec.ts` (MODIFY — the three staff routes are no longer placeholders)
- `scripts/assert-integration-tests-ran.ts` (MODIFY — require the staff-ops suites)
- `scripts/assert-integration-tests-ran.test.ts` (MODIFY)
- `docs/testing.md` (MODIFY — the staff journey and the roll-up guarantee)
- `docs/as-built.md` (MODIFY — record this program's surfaces and package)

## Existing Interfaces to Consume

The seeded users. `FRONT_OF_HOUSE` already exists — this journey is its first
use anywhere in the suite:

```ts
export const TEST_USERS: Record<Role, TestUser> = {
  CUSTOMER: { cognitoSub: 'e2e|customer', email: 'e2e-customer@example.test', role: 'CUSTOMER' },
  FRONT_OF_HOUSE: { cognitoSub: 'e2e|front-of-house', email: 'e2e-front-of-house@example.test', role: 'FRONT_OF_HOUSE' },
  MANAGER: { cognitoSub: 'e2e|manager', email: 'e2e-manager@example.test', role: 'MANAGER' },
  ADMIN: { cognitoSub: 'e2e|admin', email: 'e2e-admin@example.test', role: 'ADMIN' },
};
```

How Phase 3's journey signs in per role and shares a context across a serial
run:

```ts
import { createRoleContext } from './fixtures/session';

test.describe.configure({ mode: 'serial' });
// managerContext = await createRoleContext(browser, 'MANAGER');
```

The skip audit, which fails CI when a required suite is absent or reports zero
executed tests:

```ts
export const REQUIRED_INTEGRATION_SUITES = [
  'integration: reservation concurrency (SC-08)',
  'integration: migrations and database-level constraints',
  'integration: recordPaymentFromWebhook',
  'integration: syncCatalog',
  'integration: catalog-admin offerings',
  'integration: catalog-admin occurrences',
  'integration: catalog-admin audit',
] as const;
```

## Implementation Steps

1. **Register `staff-ops` in `vitest.workspace.ts`** if WS-03 did not already.
   Without it the package's suites never run under `pnpm test` and its coverage
   is invisible — a vacuous pass, which is precisely what the audit exists to
   catch.

2. **Seed a today occurrence with confirmed participants** in
   `fixtures/seed.ts`. The staff journey needs an occurrence **starting today**
   in the cafe's timezone with at least two `CONFIRMED` participants — the
   existing ordering fixtures seed a future class, which `/staff/today`
   correctly excludes.

   Follow the existing fixture convention: fixed ids, upserted, generous
   capacity, so repeated local runs do not accumulate duplicates. Compute the
   start time relative to the current cafe day rather than hardcoding an
   instant, or the fixture stops being "today" tomorrow.

   Seed the occurrence **in progress** — started shortly before now, ending
   later — so the occupancy assertion has something to count without waiting.

3. **Write the staff journey** in `staff-check-in.spec.ts`, signed in as the
   seeded `FRONT_OF_HOUSE` user:

   a. Visit `/staff/today`; assert the seeded class appears with its
      `arrived / expected` count showing **0 arrived**.
   b. Follow the card's link to `/staff/check-in`; assert the roster lists the
      seeded participants **by name**.
   c. Check in the first participant; assert the row shows a check-in time and
      an undo control.
   d. Return to `/staff/today`; assert the arrived count is now **1**.
   e. **Visit `/staff/occupancy`; assert the total headcount includes that
      participant.** **This is SC-17, and the assertion the whole program
      exists to satisfy.**
   f. Undo the check-in; assert `/staff/occupancy` drops back.

   Assert on **concrete numbers** — `0`, then `1`, then back — not merely that
   the page rendered. A journey that only asserts "a number is present" would
   pass against an implementation that never writes anything.

4. **Add a role-refusal assertion** to the same spec: sign in as the seeded
   `CUSTOMER` and assert `/staff/check-in` redirects to `/auth/unauthorized`.
   The route guard and the action guard are separate, and this covers the
   route.

5. **Update `routes.spec.ts`**: the three staff routes now render real content
   for `FRONT_OF_HOUSE` rather than a placeholder panel. Assert they render,
   and remove them from any placeholder expectation.

6. **Extend the skip audit** to require the staff-ops integration suites by
   name — the check-in suite and the queries suite. Naming them means deleting
   one fails CI rather than quietly reducing coverage.

   The check-in suite matters most: SC-11's roll-back guarantee and the
   roll-up-consistency cases are the kind of thing that is easy to delete when
   it becomes inconvenient, and impossible to notice missing.

7. **Update `docs/testing.md`** with the staff journey, the seeded
   `FRONT_OF_HOUSE` user, and a short note on why the roll-up is asserted
   against a multi-participant reservation rather than a single one.

8. **Update `docs/as-built.md`** for this program: the new `staff-ops` package,
   the three staff surfaces, `recordAuditEntry`'s move to `packages/database`,
   `CAFE_TIME_ZONE`'s move to `contracts`, and `RESERVATION_TRANSITIONS`.

   Also **correct two stale claims** the snapshot currently makes:

   - It says `/staff/occupancy` "still renders fake data." It did not — it was
     a plain `PlaceholderPanel` before this program.
   - Its Known Limitations should no longer list the staff surfaces as
     unbuilt, and should record what this program deliberately left out:
     no check-out, no walk-ups, and no correction path for a mistaken
     `NO_SHOW`.

9. **Run the full verification suite**: `pnpm -r typecheck`, `pnpm -r lint`,
   `pnpm test`, `pnpm -r build`, `pnpm test:integration-audit`, and
   `pnpm test:e2e`.

## Tests

The deliverables here are largely tests; these are the assertions about them.

1. **`staff-ops` appears in the Vitest workspace** — Assert
   `vitest.workspace.ts` includes it.
2. **`pnpm test` executes the staff-ops suites** — Assert a non-zero test count
   for the package in the JSON report.
3. **The seeded today occurrence is in the cafe's current day** _(e2e)_ —
   Assert the fixture's start falls inside today's cafe-day bounds, so the
   fixture cannot silently stop being "today".
4. **`/staff/today` shows the seeded class with 0 arrived** _(e2e)_ — Assert
   the class name and a `0` arrived count. **SC-01.**
5. **The card links to the roster for that occurrence** _(e2e)_ — Assert
   navigation reaches the right roster.
6. **The roster lists seeded participants by name** _(e2e)_ — Assert the names,
   not ids.
7. **Checking in a participant shows a time and an undo control** _(e2e)_ —
   Assert both.
8. **`/staff/today` then shows 1 arrived** _(e2e)_ — Assert the count changed
   from `0` to exactly `1`. **This is the write actually landing.**
9. **`/staff/occupancy` counts the checked-in participant** _(e2e)_ — Assert the
   headcount includes them. **This is SC-17.**
10. **Undo drops the occupancy count back** _(e2e)_ — Assert it returns to its
    prior value, proving the reversal is real and not just a UI state.
11. **The roll-up survives the round trip** _(e2e)_ — After undoing the only
    check-in, assert `/staff/today` shows `0` arrived again.
12. **A CUSTOMER cannot reach `/staff/check-in`** _(e2e)_ — Assert a redirect
    to `/auth/unauthorized`.
13. **The three staff routes render for FRONT_OF_HOUSE** _(e2e)_ — Assert each
    renders real content and no `PlaceholderPanel`.
14. **The skip audit requires the staff-ops suites** — Feed it a report missing
    the check-in suite; assert a non-zero exit.
15. **The skip audit passes when they ran** — Feed a report containing them
    with non-zero counts; assert exit zero.
16. **The skip audit still fails on a zero-count integration suite** — Assert
    the pre-existing behavior is unchanged by the additions.
17. **The skip audit still requires the Phase 3 suites** — Assert the three
    `catalog-admin` entries remain, so this program's additions did not
    displace them.
18. **`docs/as-built.md` describes the staff surfaces** — Assert it mentions
    `staff-ops` and the three routes, and no longer claims `/staff/occupancy`
    renders fake data.

## Acceptance Criteria

1. All verification commands pass workspace-wide, including
   `pnpm test:integration-audit` and `pnpm test:e2e`.
2. `staff-ops` is registered in the Vitest workspace and its suites execute
   under `pnpm test` (tests 1–2).
3. The e2e fixture seeds an in-progress occurrence in the cafe's current day,
   computed relative to now rather than hardcoded (test 3).
4. The Playwright journey covers today → check in → occupancy reflects them,
   asserting concrete counts of `0`, `1`, and back (tests 4–11). **SC-17.**
5. Undo returns both the arrived count and the occupancy headcount to their
   prior values (tests 10–11).
6. A `CUSTOMER` is refused at `/staff/check-in` (test 12).
7. All three staff routes render real content for `FRONT_OF_HOUSE` (test 13).
8. The skip audit names the staff-ops check-in and queries suites, fails when
   either is absent, and still requires the Phase 3 suites (tests 14–17).
9. `docs/testing.md` documents the staff journey and the seeded
   `FRONT_OF_HOUSE` user.
10. `docs/as-built.md` records this program, corrects the `/staff/occupancy`
    "fake data" claim, and lists what was deliberately left out — no check-out,
    no walk-ups, no `NO_SHOW` correction path (test 18).
