# WS-09: Tests, e2e coverage, and documentation

## Goal

Close the program with the coverage that only makes sense once every piece
exists: a Playwright journey proving a manager can create a class that a
customer can then book, and documentation of the admin surface.

The journey is the point. Every other workstream verifies its own piece; this
one verifies that the pieces connect — that publishing in `/admin/offerings`
and scheduling in `/admin/schedules` actually produces a bookable class on
`/book`. That is the program's whole claim.

## Traceability

- **SC-16** — Playwright covers creating and publishing a class, scheduling it,
  and seeing it appear on `/book`.
- **SC-07** — A scheduled occurrence of a published offering appears on `/book`
  with its seat count.
- **SC-11** — Partially: asserts the audit integration suites are not silently
  skipped in CI.

## Dependencies

- **WS-06** — `/admin/offerings`.
- **WS-07** — `/admin/schedules`.
- **WS-08** — `/admin/reservations`.

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Testing" and "Delivery"
- `docs/vision.md` — "Scope: Phase 2+"
- `docs/testing.md` — the existing strategy, the Square stubbing approach, and
  the skip audit this program extends
- `apps/web/e2e/ordering.spec.ts` — the customer journey to mirror and extend
- `apps/web/e2e/fixtures/seed.ts` — `TEST_USERS`, including the `MANAGER` user
  this journey signs in as
- `apps/web/e2e/fixtures/session.ts` — how a spec signs in as a given role
- `scripts/assert-integration-tests-ran.ts` — the skip audit, and the suite
  names it requires
- `vitest.workspace.ts` — where `catalog-admin` must be registered
- `docs/environment.md` — the environment contract

## Package

`apps/web`, plus workspace-level test configuration and docs.

## Files Touched

- `apps/web/e2e/admin-catalog.spec.ts` (NEW — the create-to-bookable journey)
- `apps/web/e2e/fixtures/seed.ts` (MODIFY — expose an admin-catalog reset helper)
- `scripts/assert-integration-tests-ran.ts` (MODIFY — require the catalog-admin suites)
- `scripts/assert-integration-tests-ran.test.ts` (MODIFY)
- `docs/testing.md` (MODIFY — admin journey and the audit-in-transaction guarantee)
- `docs/as-built.md` (MODIFY — record this program's surfaces and the first audit writer)

## Existing Interfaces to Consume

The seeded users. `MANAGER` already exists — this journey is its first use:

```ts
export const TEST_USERS: Record<Role, TestUser> = {
  CUSTOMER: { cognitoSub: 'e2e|customer', email: 'e2e-customer@example.test', role: 'CUSTOMER' },
  FRONT_OF_HOUSE: { cognitoSub: 'e2e|front-of-house', email: 'e2e-front-of-house@example.test', role: 'FRONT_OF_HOUSE' },
  MANAGER: { cognitoSub: 'e2e|manager', email: 'e2e-manager@example.test', role: 'MANAGER' },
  ADMIN: { cognitoSub: 'e2e|admin', email: 'e2e-admin@example.test', role: 'ADMIN' },
};
```

The skip audit, which fails CI when an `integration:` suite reports zero
executed tests and when a named suite is absent entirely:

```ts
// Fails loudly when any `integration:` suite reports zero executed tests, or
// when one of the suites this program's risk register names is absent
// entirely — a suite that was deleted rather than skipped.
```

The customer journey this extends — it seeds its own class; the new spec
creates one through the UI instead:

```ts
// apps/web/e2e/ordering.spec.ts
// browse -> participant selection -> cart -> checkout redirect
```

## Implementation Steps

1. **Register `catalog-admin` in `vitest.workspace.ts`** if WS-02 did not
   already. Without it the package's suites never run under `pnpm test` and its
   coverage is invisible — a vacuous pass, which is precisely what the audit
   exists to catch.

2. **Write the admin journey** in `admin-catalog.spec.ts`, signed in as the
   seeded `MANAGER`:

   a. Visit `/admin/offerings`; create a class with a distinctive name, a
      duration, a capacity, and a price entered in dollars.
   b. Assert it appears in the list as `DRAFT`.
   c. Publish it; assert the status becomes `PUBLISHED`.
   d. Visit `/admin/schedules`; schedule an occurrence for that class at a
      future time.
   e. Assert it appears in the schedule with `0 / capacity` booked.
   f. **Sign in as the seeded `CUSTOMER` and visit `/book`. Assert the class
      appears with its price and full seat count.** **This is SC-16 and SC-07,
      and it is the assertion the whole program exists to satisfy.**

   Use a distinctive generated name per run so the spec cannot pass by finding
   a class some other test or the demo seed left behind. Asserting on a name
   that already exists is the easiest way for this journey to be green while
   proving nothing.

   Assert the price rendered on `/book` matches the dollars entered in the
   admin form — that is the round trip through dollars → integer cents →
   formatted dollars, and a rounding error anywhere in it shows up here.

3. **Add a draft-invisibility assertion** to the same spec: unpublish the class
   as the manager, then assert it disappears from `/book`. Publishing is the
   control that makes something sellable, so the negative case matters as much
   as the positive one.

4. **Extend the skip audit** to require the catalog-admin integration suites by
   name — the offering command suite, the occurrence command suite, and the
   audit suite. Naming them means deleting one fails CI rather than quietly
   reducing coverage.

   The audit suite matters most: SC-11's rollback guarantee is the kind of
   thing that is easy to delete when it becomes inconvenient, and impossible to
   notice missing.

5. **Update `docs/testing.md`** with the admin journey, the seeded `MANAGER`
   user, and a short note on why audit entries are asserted inside a rolled-back
   transaction rather than merely present after a success.

6. **Update `docs/as-built.md`.** It is currently stale — it still describes the
   system as it stood after `phase-1-scaffold`, saying every domain command is a
   stub and every page a placeholder, which has not been true since
   `phase-2-square-ordering` shipped.

   Bring it current for **both** programs: the ordering surfaces, the two
   packages Phase 2 added, the capacity trigger, and now `catalog-admin`, the
   admin surfaces, and the fact that `staff_audit_log` finally has a writer.

   Left stale, it actively misleads the next program's planning — this program
   had to work around it, and the next one should not have to.

7. **Run the full verification suite**: `pnpm -r typecheck`, `pnpm -r lint`,
   `pnpm test`, `pnpm -r build`, and `pnpm test:e2e`.

## Tests

The deliverables here are largely tests; these are the assertions about them.

1. **`catalog-admin` appears in the Vitest workspace** — Assert
   `vitest.workspace.ts` includes it.
2. **`pnpm test` executes the catalog-admin suites** — Assert a non-zero test
   count for the package in the JSON report.
3. **A manager can create a class** _(e2e)_ — Assert it appears as `DRAFT`
   with the entered name.
4. **Publishing changes the status in the list** _(e2e)_ — Assert `PUBLISHED`.
5. **A manager can schedule an occurrence** _(e2e)_ — Assert it appears on
   `/admin/schedules` with `0 /` its capacity.
6. **The scheduled class appears on `/book` for a customer** _(e2e)_ — Assert
   the name and seat count. **This is SC-07 and the core of SC-16.**
7. **The price on `/book` matches the dollars entered** _(e2e)_ — Enter
   `$45.50`; assert `/book` renders `$45.50`, proving the dollars → cents →
   dollars round trip.
8. **The class name is unique per run** _(e2e)_ — Assert the generated name is
   used, so the journey cannot pass on a leftover class from the demo seed or
   another spec.
9. **Unpublishing removes it from `/book`** _(e2e)_ — Assert the class
   disappears for the customer, proving publication is what gates visibility.
10. **A customer cannot reach `/admin/offerings`** _(e2e)_ — Sign in as
    `CUSTOMER`; assert a redirect to `/auth/unauthorized`. The route guard and
    the action guard are separate, and this covers the route.
11. **The skip audit requires the catalog-admin suites** — Feed it a report
    missing the audit suite; assert a non-zero exit.
12. **The skip audit passes when they ran** — Feed a report containing them
    with non-zero counts; assert exit zero.
13. **The skip audit still fails on a zero-count integration suite** — Assert
    the pre-existing behavior is unchanged by the additions.
14. **`docs/as-built.md` describes the current system** — Assert it mentions
    `catalog-admin`, the admin surfaces, and that it no longer claims every
    domain command is a stub.

## Acceptance Criteria

1. All four verification commands pass workspace-wide, and `pnpm test:e2e`
   passes.
2. `catalog-admin` is registered in the Vitest workspace and its suites execute
   under `pnpm test` (tests 1–2).
3. The Playwright journey covers create → publish → schedule → visible on
   `/book`, with a per-run unique class name (tests 3–8). **SC-16, SC-07.**
4. The price entered in dollars renders identically on `/book`, proving the
   integer-cents round trip (test 7).
5. Unpublishing removes the class from the customer surface (test 9).
6. A `CUSTOMER` is refused at `/admin/offerings` (test 10).
7. The skip audit names the catalog-admin offering, occurrence, and audit
   suites, and fails when any is absent (tests 11–13).
8. `docs/testing.md` documents the admin journey and the audit-in-transaction
   assertion.
9. `docs/as-built.md` is brought current for **both** `phase-2-square-ordering`
   and this program, and no longer describes domain commands as stubs
   (test 14).
