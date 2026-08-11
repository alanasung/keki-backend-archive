# WS-12: Test coverage, end-to-end specs, and documentation

## Goal

Close the program: a Playwright journey covering browse → cart → checkout
against a stubbed Square client, documentation for every new secret, and a CI
audit that proves the integration tests this program depends on **actually run**
rather than silently skipping.

That last item is the substantive one. This program's most important guarantees —
capacity under concurrency, webhook idempotency, migration correctness — live in
`describe.skipIf(!hasLiveDatabase)` suites. A CI run where those skip is green
and meaningless, which the program's risk register names explicitly.

## Traceability

- **SC-15** — Playwright covers browse → participant selection → cart → checkout
  redirect against a stubbed Square client.
- **SC-16** — `docs/environment.md` documents every new secret and the
  sandbox/production credential split.
- **SC-20** — A sandbox payment completed end to end delivers a signed webhook
  that fulfills its order.
- **SC-08** — Partially: asserts the concurrency suites are not skipped in CI.
- **SC-13** — Partially: same, for webhook idempotency.

## Dependencies

- **WS-10** — Webhook fulfillment.
- **WS-11** — Infrastructure.
- **WS-13** — Checkout action and composition root (the journey under test ends
  at the Square redirect this workstream produces).

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Testing" and "Delivery"; Vitest colocated, Playwright across
  route groups, every package defines all four scripts
- `docs/vision.md` — "Scope: Phase 2+"
- `docs/testing.md` — the existing testing strategy this extends
- `docs/environment.md` — the environment contract to update
- `playwright.config.ts` — existing e2e configuration
- `vitest.workspace.ts` — workspace project definitions; new packages must be
  registered
- `.github/workflows/ci.yml` — the per-run Neon test branch and the gates
- `packages/square-client/src/stub.ts` — `createStubSquareClient` from WS-03
- `apps/web/app/(customer)/book/page.tsx` — the ordering page under test
- `apps/web/app/(customer)/cart/actions.ts` — the checkout action under test

## Package

`apps/web`, plus workspace-level test and CI configuration.

## Files Touched

- `apps/web/e2e/ordering.spec.ts` (NEW) — the browse → cart → checkout journey
- `apps/web/e2e/fixtures/square-stub.ts` (NEW) — deterministic Square stub
- `apps/web/e2e/fixtures/seed.ts` (NEW) — catalog and occurrence seeding
- `vitest.workspace.ts` (MODIFY) — register `square-client` and `catalog-core`
- `playwright.config.ts` (MODIFY) — env wiring for the stub
- `.github/workflows/ci.yml` (MODIFY) — integration-suite audit
- `scripts/assert-integration-tests-ran.ts` (NEW) — the skip audit
- `docs/environment.md` (MODIFY) — new secrets and credential split
- `docs/testing.md` (MODIFY) — stubbing strategy and the skip audit

## Existing Interfaces to Consume

The stub from WS-03, which the e2e run uses instead of calling Square:

```ts
export function createStubSquareClient(overrides?: Partial<SquareClient>): SquareClient;
```

The skip pattern every integration suite in this program uses. The audit exists
because this expression silently disables tests when the variable is absent:

```ts
describe.skipIf(!hasLiveDatabase)('integration: migrations and database-level constraints', () => {
```

The CI shape to extend — it already provisions a per-run Neon branch, so the
integration suites *can* run there and must be proven to:

```yaml
# .github/workflows/ci.yml
# pnpm install → per-run Neon test branch → typecheck, lint, test, build,
# Playwright e2e. A scheduled workflow sweeps leaked ci-* Neon branches.
```

## Implementation Steps

1. **Register the new packages** in `vitest.workspace.ts`. `square-client` and
   `catalog-core` must appear, or their suites never run under `pnpm -r test`
   and their coverage is invisible — a vacuous pass.

2. **Build the Square stub fixture** for e2e. Return a deterministic
   `checkoutUrl` on an origin the test controls, so the journey can assert the
   redirect without leaving the test environment or contacting Square.

   Wire it through an environment flag the app honours only outside production,
   following the `createNoopProviders` and `COGNITO_ISSUER` precedents. A
   test-only substitution that could activate in production is an outage
   waiting to happen.

3. **Build the seed fixture**: a published `CLASS` offering with a future
   occurrence and known capacity, plus catalog rows with known prices. Seed
   deterministically and clean up after, so runs are independent.

4. **Write the ordering journey** in `ordering.spec.ts`, signed in as a customer
   whose household includes at least one child:

   a. Visit `/book`; assert a cafe item and a class occurrence render with
      prices and seat counts.
   b. Add a cafe item; assert the cart reflects it.
   c. Open the participant picker for the class, select the child, and submit.
   d. Visit `/cart`; assert the server-computed subtotal matches the seeded
      prices exactly, and that the selected child's name renders on the class
      line.
   e. Click checkout; assert navigation to the stub's checkout URL. **This is
      SC-15.**

   Assert the subtotal by computing it from seeded values in the test, not by
   reading it off the page and comparing it to itself.

   Seed the household with a child specifically. A journey that books the
   account holder would pass even if participant selection were broken for the
   case the product actually exists to serve.

5. **Add a price-tamper e2e assertion.** Intercept the checkout request and
   inject a forged cart cookie carrying `unitPriceCents`; assert checkout is
   rejected and no order is created. Unit tests cover this at three layers
   already; this proves the layers compose in a running app.

5a. **Write the sandbox payment-to-fulfillment test** in
   `apps/web/e2e/sandbox-fulfillment.spec.ts`, gated on
   `SQUARE_ACCESS_TOKEN` being present and skipped otherwise. Unlike every other
   test in this program, it uses the **real** Square client:

   a. Create an order and start checkout against the Square sandbox.
   b. Complete the sandbox payment through Square's test payment flow.
   c. Capture the resulting webhook — either delivered to a reachable stage URL
      or replayed from Square's dashboard payload — and post it, **with its real
      signature**, to the deployed webhook endpoint.
   d. Assert the order reaches `PAID` and its class reservation is `CONFIRMED`.

   **This is SC-20, and it is the only test that exercises the real
   payment-to-fulfillment path.** Everything else mocks the cores or stubs
   Square, so a genuine integration break — a wrong reference field, a signature
   mismatch, a payload shape Square actually sends but the parser rejects —
   passes every other gate in the program.

   Because it requires credentials and a deployed endpoint, it does not gate CI.
   Run it before a production release and record the result. A test that cannot
   run in CI is still worth having; a claim that it ran when it did not is not.

6. **Write the skip audit** in `scripts/assert-integration-tests-ran.ts`. Parse
   the Vitest JSON report and fail when any suite whose name begins
   `integration:` reports zero executed tests.

   Run it in CI **after** the test step, only in the job where the Neon branch
   exists. This converts "the gate cannot fail" into "the gate fails loudly",
   which is the point of the risk-register entry.

   Name the specific suites it must find — capacity concurrency (WS-06), schema
   constraints (WS-02), webhook idempotency (WS-10), and catalog sync (WS-04) —
   so deleting a suite is a CI failure rather than a quiet coverage loss.

7. **Update `.github/workflows/ci.yml`**: emit the Vitest JSON report, run the
   audit, and ensure `SQUARE_ACCESS_TOKEN` for sandbox tests is either provided
   or the sandbox suites are explicitly acknowledged as skipped in the run
   summary. Do not fail CI for absent Square credentials — but do not let their
   absence look like a pass either.

8. **Update `docs/environment.md`** with `SquareAccessToken`,
   `SquareWebhookSignatureKey`, `SquareEnvironment`, `CartCookieSecret`, and
   `AppBaseUrl`: what each is, where it comes from, and which are per-stage.

   Document the sandbox/production split explicitly, including the WS-03 guard
   that refuses sandbox credentials when `NODE_ENV === 'production'`, and state
   that `SQUARE_NOTIFICATION_URL` must match Square's dashboard registration
   character for character — a trailing slash breaks every verification and
   looks identical to an attack.

9. **Update `docs/testing.md`** with the Square stubbing strategy, the seeding
   fixtures, and the skip audit and why it exists.

10. **Run the full verification suite**: `pnpm -r typecheck`, `pnpm -r lint`,
    `pnpm -r test`, `pnpm -r build`, and `pnpm test:e2e`.

## Tests

The deliverables here are largely tests; these are the assertions about them.

1. **Both new packages appear in the Vitest workspace** — Assert
   `vitest.workspace.ts` includes `square-client` and `catalog-core`.
2. **`pnpm -r test` executes both new packages' suites** — Assert non-zero test
   counts for each in the JSON report.
3. **Browse renders seeded catalog and classes** _(e2e)_ — Assert a cafe item
   and a class occurrence with price and seats.
4. **Add to cart updates the cart** _(e2e)_ — Assert the line appears.
5. **Cart subtotal matches seeded prices** _(e2e)_ — Assert against
   independently computed values.
6. **Checkout redirects to the stub URL** _(e2e)_ — Assert navigation. **This is
   SC-15.**
6a. **The class line names the selected child** _(e2e)_ — Assert the child's
   display name renders on the cart line, proving participant selection survives
   the whole journey.
6b. **Sandbox payment fulfills its order** _(e2e, skipped without credentials)_ —
   Complete a sandbox payment, deliver its signed webhook, and assert the order
   is `PAID` with its reservation `CONFIRMED`. **This is SC-20.**
7. **A forged cart cookie is rejected end to end** _(e2e)_ — Assert rejection and
   that no order row was created.
8. **The Square stub is refused in production** — Assert the app throws when the
   stub flag is set with `NODE_ENV=production`.
9. **The skip audit fails when an integration suite is skipped** — Feed it a
   report with zero executed integration tests; assert a non-zero exit.
10. **The skip audit passes when they ran** — Feed a report with executed
    integration tests; assert exit zero.
11. **The audit names the required suites** — Assert it fails when the capacity
    concurrency suite is absent entirely, not merely skipped.
12. **CI runs the audit after tests** — Assert the workflow orders the steps
    correctly and runs the audit in the Neon-branch job.
13. **`docs/environment.md` documents every new secret** — Assert each of the
    five names appears. **This is SC-16.**
14. **`docs/environment.md` documents the credential split** — Assert the
    sandbox/production guard and the notification-URL exactness note.
15. **No secret value is committed** — Assert the docs contain placeholders, not
    live tokens, and that no `.env` file was added.

## Acceptance Criteria

1. All four verification commands pass workspace-wide, and `pnpm test:e2e`
   passes.
2. `square-client` and `catalog-core` are registered in the Vitest workspace and
   their suites execute under `pnpm -r test`.
3. The Playwright journey covers browse → participant selection → cart review →
   checkout redirect against a stubbed Square client, with a real child as the
   class participant (SC-15, tests 3–6a).
3a. A sandbox payment-to-fulfillment test exists, uses the real Square client and
   a real signature, and asserts the order reaches `PAID` with its reservation
   `CONFIRMED` (SC-20). It is skipped without credentials and is reported as
   skipped rather than passing.
4. The CI e2e run never contacts Square, and the stub cannot activate in
   production.
5. An end-to-end price-tamper attempt is rejected with no order created.
6. The skip audit fails CI when any `integration:` suite reports zero executed
   tests (tests 9–11), and runs in the job that provisions the Neon branch.
7. The audit names the capacity-concurrency, schema-constraint, webhook-
   idempotency, and catalog-sync suites, so deleting one fails CI.
8. Absent Square sandbox credentials do not fail CI but are reported rather than
   presented as a pass.
9. `docs/environment.md` documents all five new secrets, the sandbox/production
   split and its guard, and the exact-match requirement for
   `SQUARE_NOTIFICATION_URL` (SC-16).
10. `docs/testing.md` documents the stubbing strategy, seeding, and the skip
    audit.
11. No credential values are committed.
