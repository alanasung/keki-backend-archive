# WS-09: Tests, e2e coverage, and documentation

## Goal

Close the program with the coverage that only makes sense once every piece
exists: a Playwright journey proving a brand-new customer can complete a
profile, add a child, and book that child into a class — and documentation of
the auth handshake.

The journey is the point. Every other workstream verifies its own piece; this
one verifies the chain that made the program worth running: an account is
useless without a child, and a child is useless unless the booking flow can see
them.

It also carries an unusual obligation. This program changes the cookie every
existing Playwright spec depends on, so **proving the old fixtures still work
is a deliverable**, not a side effect.

## Traceability

- **SC-18** — Playwright covers the journey: complete a profile, add a child,
  and book that child into a class.
- **SC-15** — A newly added child appears as a bookable participant.
- **SC-17** — The existing Playwright session fixtures still work unchanged.
- **SC-10** — Partially: asserts profile completion stays idempotent end to end.

## Dependencies

- **WS-04** — The auth routes.
- **WS-05** — `/auth/complete-profile`.
- **WS-07** — The editable `/account`.
- **WS-08** — `/admin/customers`.

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Testing" and "Delivery"
- `docs/vision.md` — "Target Users"
- `docs/testing.md` — the existing strategy, the JWKS-server fixture approach,
  and the skip audit this extends
- `apps/web/e2e/fixtures/session.ts` — `createRoleContext` and the cookie it
  sets; the contract this program must not have moved
- `apps/web/e2e/fixtures/seed.ts` — `TEST_USERS` and the ordering fixtures
- `apps/web/e2e/fixtures/jwks-server.ts` — `signIdToken`, and why e2e signs its
  own tokens rather than using Cognito
- `apps/web/e2e/auth.spec.ts` — the existing authorization-matrix spec
- `apps/web/e2e/ordering.spec.ts` — the browse-to-checkout journey this extends
- `apps/web/e2e/staff-check-in.spec.ts` — Phase 4's journey, the spec to mirror
- `scripts/assert-integration-tests-ran.ts` — the skip audit and
  `REQUIRED_INTEGRATION_SUITES`
- `docs/as-built.md` — the snapshot to bring current
- `docs/environment.md` — where the new Cognito variables are documented

## Package

`apps/web`, plus workspace-level test configuration and docs.

## Files Touched

- `apps/web/e2e/customer-onboarding.spec.ts` (NEW — the profile-to-booking journey)
- `apps/web/e2e/fixtures/seed.ts` (MODIFY — an unprovisioned test user)
- `apps/web/e2e/auth.spec.ts` (MODIFY — sign-in now redirects rather than rendering)
- `apps/web/e2e/routes.spec.ts` (MODIFY — /admin/customers is no longer a placeholder)
- `scripts/assert-integration-tests-ran.ts` (MODIFY — require the customer-core suites)
- `scripts/assert-integration-tests-ran.test.ts` (MODIFY)
- `docs/testing.md` (MODIFY — the onboarding journey and what e2e cannot cover)
- `docs/as-built.md` (MODIFY — record this program)

## Existing Interfaces to Consume

The fixture that signs its own tokens — the reason the real handshake cannot be
driven end to end here, and the contract WS-04 had to preserve:

```ts
export async function createRoleContext(browser: Browser, role: Role): Promise<BrowserContext> {
  const user: TestUser = TEST_USERS[role];
  return contextWithIdTokenCookie(browser, user.cognitoSub, user.email);
}

/** A signed, verifiable token cookie for a cognitoSub with no seeded profile row — the `unprovisioned` case. */
export async function createUnprovisionedContext(browser: Browser): Promise<BrowserContext>;

/** No id-token cookie at all — the `anonymous` case. */
export async function createAnonymousContext(browser: Browser): Promise<BrowserContext>;
```

> `createUnprovisionedContext` **already exists** and was written for exactly
> the case `/auth/complete-profile` now handles. This journey is its first real
> use.

The seeded users:

```ts
export const TEST_USERS: Record<Role, TestUser> = {
  CUSTOMER: { cognitoSub: 'e2e|customer', email: 'e2e-customer@example.test', role: 'CUSTOMER' },
  FRONT_OF_HOUSE: { cognitoSub: 'e2e|front-of-house', email: 'e2e-front-of-house@example.test', role: 'FRONT_OF_HOUSE' },
  MANAGER: { cognitoSub: 'e2e|manager', email: 'e2e-manager@example.test', role: 'MANAGER' },
  ADMIN: { cognitoSub: 'e2e|admin', email: 'e2e-admin@example.test', role: 'ADMIN' },
};
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
  // plus the staff-ops suites added by phase-4-staff-surfaces
] as const;
```

## Implementation Steps

1. **Write the onboarding journey** in `customer-onboarding.spec.ts`, starting
   from `createUnprovisionedContext` — a verified token with no `customers`
   row, which is exactly what a brand-new Cognito account looks like:

   a. Visit `/book`; assert a redirect to `/auth/complete-profile`. That is the
      guard doing its job and the state this program exists to resolve.
   b. Complete the profile with a first and last name; assert the redirect
      lands on the page originally requested.
   c. Visit `/account`; assert the household exists and lists **no children**.
   d. Add a child with a distinctive per-run name and a date of birth; assert
      the child appears in the list.
   e. **Visit `/book`, open the participant picker for a class, and assert the
      newly added child is selectable.** **This is SC-15 and the core of
      SC-18** — the assertion that connects an account to a purchase.
   f. Book a seat for that child and assert the reservation carries their name.

   Use a per-run unique child name so the journey cannot pass by finding a
   child the seed script left behind. Phase 3 established that discipline for
   exactly this reason.

2. **Add an idempotence assertion**: submit the profile form a second time (or
   revisit `/auth/complete-profile` after provisioning) and assert the customer
   still has exactly one household. **SC-10** end to end, rather than only at
   the action.

3. **Prove the cookie contract did not move.** Assert every existing spec that
   uses `createRoleContext` still passes untouched. Concretely: do not modify
   `fixtures/session.ts`, and add an assertion that the cookie it sets is still
   the one `/auth/callback` writes — same name, same `httpOnly`, same path.

   **This is SC-17**, and it is the single most likely way this program breaks
   something unrelated. A renamed cookie fails every spec at once and looks like
   an auth bug rather than a rename.

4. **Update `auth.spec.ts`.** `/auth/sign-in` no longer renders a placeholder;
   it redirects to Cognito. Assert the **redirect target's shape** — that it
   goes to the configured hosted UI with `response_type=code` and a
   `code_challenge` — rather than following it. CI has no user pool, and
   Cognito's hosted UI is not ours to drive.

   Say so in a comment. A future reader will otherwise assume the missing
   coverage is an oversight rather than a boundary.

5. **Update `routes.spec.ts`**: `/admin/customers` now renders real content for
   a `MANAGER`. Assert it renders and remove it from any placeholder
   expectation.

6. **Extend the skip audit** to require the customer-core integration suites by
   name — the children suite and the search suite. Naming them means deleting
   one fails CI rather than quietly reducing coverage.

7. **Update `docs/testing.md`** with the onboarding journey, the unprovisioned
   fixture, and — importantly — **what e2e deliberately does not cover here**:
   the hosted-UI form itself, the real token exchange, and Cognito's own error
   pages. State that the callback is covered by unit tests against a stubbed
   token endpoint, so the gap is a documented boundary rather than an unknown.

8. **Update `docs/as-built.md`** for this program: the OAuth handshake in
   `@keki/auth`, the four session cookies, the new auth routes, `customer-core`'s
   first write paths since Phase 1, the editable `/account`, and
   `/admin/customers`.

   Move `addChild` and `updateHousehold` out of the Known Limitations list, and
   record what this program deliberately left: social login, MFA, child editing
   and deletion, and staff editing a household.

9. **Run the full verification suite**: `pnpm -r typecheck`, `pnpm -r lint`,
   `pnpm -r build`, `pnpm test:integration-audit`, and `pnpm test:e2e`.

   > The build gate does not run Playwright — see `pipeline.config.json`'s
   > `verify` block. Run `pnpm test:e2e` by hand before reporting this
   > workstream complete; twice now a program's central criterion has been a
   > journey a green build never executed.

## Tests

The deliverables here are largely tests; these are the assertions about them.

1. **The unprovisioned fixture reaches complete-profile** _(e2e)_ — Visit
   `/book` with no profile; assert the redirect to `/auth/complete-profile`.
   **SC-08.**
2. **Completing the profile creates a household** _(e2e)_ — Assert `/account`
   then shows a household.
3. **The user lands back on the page they requested** _(e2e)_ — Assert the
   redirect after completion goes to `/book`. **SC-09.**
4. **A second completion creates no second household** _(e2e)_ — Assert exactly
   one household remains. **SC-10.**
5. **A new household lists no children** _(e2e)_ — Assert the empty state, so
   the next assertion is meaningful.
6. **Adding a child shows them on `/account`** _(e2e)_ — Assert the per-run
   name appears. **SC-11.**
7. **The child's name is unique per run** _(e2e)_ — Assert the generated name
   is used, so the journey cannot pass on a leftover child.
8. **The child is selectable in the booking participant picker** _(e2e)_ —
   Assert the name appears as a choosable participant on `/book`. **This is
   SC-15 and the core of SC-18.**
9. **Booking that child produces a reservation carrying their name** _(e2e)_ —
   Assert the participant name on the resulting order or reservation.
10. **A future date of birth is refused in the UI** _(e2e)_ — Enter tomorrow;
    assert an error message and that no child is added. **SC-13** through the
    whole stack.
11. **`/auth/sign-in` redirects to the hosted UI** _(e2e)_ — Assert the
    location's host matches the configured hosted UI and the query carries
    `response_type=code` and a `code_challenge`. **SC-01.** Do not follow it.
12. **The redirect carries a `state` and sets the matching cookie** _(e2e)_ —
    Assert both. **SC-02.**
13. **`createRoleContext` still authenticates** _(e2e)_ — Assert an existing
    role context still reaches a customer page. **SC-17.**
14. **`fixtures/session.ts` is unmodified** — Compare against its state at the
    program's start (`git show HEAD:<path>`); assert it is byte-identical. The
    cookie contract moving is the failure this program is most likely to cause,
    and a modified fixture would hide it.
15. **The callback writes the same cookie name the fixture sets** — Assert both
    reference `ID_TOKEN_COOKIE_NAME` rather than a literal. **SC-17.**
16. **`/admin/customers` renders for a MANAGER** _(e2e)_ — Assert real content
    and no `PlaceholderPanel`.
17. **A CUSTOMER cannot reach `/admin/customers`** _(e2e)_ — Assert a redirect
    to `/auth/unauthorized`.
18. **The skip audit requires the customer-core suites** — Feed it a report
    missing the children suite; assert a non-zero exit.
19. **The skip audit passes when they ran** — Feed a report containing them
    with non-zero counts; assert exit zero.
20. **The skip audit still requires the earlier programs' suites** — Assert the
    catalog-admin and staff-ops entries remain, so this program's additions did
    not displace them.
21. **`docs/as-built.md` records this program** — Assert it mentions the auth
    handshake and `/admin/customers`, and **no longer lists `addChild` or
    `updateHousehold` as stubs**.
22. **`docs/testing.md` states what e2e does not cover** — Assert it names the
    hosted UI and the real token exchange as deliberate boundaries, so the gap
    reads as a decision rather than an oversight.

## Acceptance Criteria

1. All verification commands pass workspace-wide, including
   `pnpm test:integration-audit` and `pnpm test:e2e` run by hand.
2. The Playwright journey covers unprovisioned → complete profile → add child →
   book that child, with a per-run unique child name (tests 1–9). **SC-18.**
3. The newly added child is selectable in the booking participant picker
   (test 8). **SC-15.**
4. A second profile completion creates no second household (test 4). **SC-10.**
5. A future date of birth is refused through the full stack (test 10).
6. `/auth/sign-in` redirects to a correctly-formed hosted-UI URL and sets the
   state cookie, without the test following the redirect (tests 11–12).
   **SC-01, SC-02.**
7. `fixtures/session.ts` is byte-identical to its pre-program state, and the
   contexts it creates still authenticate (tests 13–15). **SC-17.**
8. `/admin/customers` renders for a MANAGER and refuses a CUSTOMER
   (tests 16–17). **SC-16.**
9. The skip audit names the customer-core children and search suites, and still
   requires every earlier program's suites (tests 18–20).
10. `docs/as-built.md` records this program and no longer lists the implemented
    commands as stubs (test 21).
11. `docs/testing.md` documents the onboarding journey **and** the deliberate
    e2e boundaries around Cognito's hosted UI (test 22).
