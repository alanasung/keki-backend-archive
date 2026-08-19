# Testing

This describes the four test layers in this repository: what each one
covers, its prerequisites, and how to run it locally and in CI. See
`AGENTS.md`'s "Testing" convention for the ground rules (Vitest colocated per
package, Playwright for the four route groups, both run in CI).

## 1. Unit and integration tests (Vitest)

Colocated with the code under test as `*.test.ts` / `*.test.tsx` files.

**Run everything:**

```sh
pnpm test          # pnpm -r test — the canonical command, what CI and
                    # pipeline.config.json's `verify` block both run
```

**Run one package** (faster while iterating):

```sh
pnpm --filter @keki/auth test
```

**Run the whole workspace as one Vitest run** (for local convenience and
coverage aggregation — `vitest.workspace.ts` enumerates every package with a
`test` script; it does not replace `pnpm -r test`):

```sh
pnpm exec vitest run
pnpm test:coverage   # same, with v8 coverage (text + lcov reporters)
```

No global coverage threshold is configured. Phase 1 is deliberately mostly
skeletons and `NotImplementedInPhase1` stubs; a percentage gate would either
be trivially satisfied by testing those throws or fail for entirely correct
reasons. `TODO(phase-2)` in `vitest.workspace.ts` tracks adding one once real
domain logic lands.

### Prerequisites

Most unit tests need nothing beyond `pnpm install` — they mock `@keki/database`
and `@keki/auth`'s network-touching pieces (see e.g.
`packages/customer-core/src/commands.test.ts`).

A handful of **integration tests** exercise a real Postgres connection
(`@keki/database`'s pooled connection string) and skip themselves via
`describe.skipIf(!hasLiveDatabase)` when `DATABASE_URL_POOLED` /
`DATABASE_URL_DIRECT` are unset — see
`packages/customer-core/src/commands.integration.test.ts` for the pattern.
Locally, set both to a real (ideally disposable/branch) Postgres URL to opt
in:

```sh
export DATABASE_URL_POOLED="postgres://...-pooler.../db?sslmode=require"
export DATABASE_URL_DIRECT="postgres://.../db?sslmode=require"
pnpm --filter @keki/customer-core test
```

In CI, these are supplied automatically by the dedicated per-run Neon branch
(see "CI" below), so integration tests run there without opting in manually.

## 2. End-to-end tests (Playwright)

`apps/web/e2e/` covers the four route groups (`routes.spec.ts`, all eleven
placeholder routes — SC-04), the authorization gate (`auth.spec.ts`, the full
`staff/`/`admin/` role matrix — SC-05), the browse-to-checkout ordering
journey against a stubbed Square client (`ordering.spec.ts` — SC-15, see
"Square stubbing and ordering fixtures" below), and a real Square sandbox
payment-to-fulfillment run (`sandbox-fulfillment.spec.ts` — SC-20, see
"Sandbox payment-to-fulfillment" below).

```sh
pnpm test:e2e                        # playwright test
pnpm exec playwright test --list     # resolve config + list specs, no run
pnpm exec playwright show-report     # open the last HTML report
```

### How sign-in is simulated

There is no real Cognito hosted UI in Phase 1 (`app/auth/sign-in` is a
placeholder), so the e2e suite cannot click through an actual sign-in flow.
Instead:

- `apps/web/e2e/fixtures/jwks-server.ts` generates (and persists to the
  gitignored `apps/web/e2e/.e2e-keys/`) an RSA signing key and a self-signed
  TLS certificate, and serves the JWKS at
  `https://localhost:3001/.well-known/jwks.json`. HTTPS, not HTTP: WS-04's
  Cognito verifier (`aws-jwt-verify`) fetches its JWKS via Node's `https`
  module unconditionally, which refuses a plain-HTTP URL outright.
- `apps/web/e2e/fixtures/seed.ts` writes one fixed test user per role
  directly into Postgres via `@keki/database` (the one place under
  `apps/web/` allowed to import it — see that file's header comment).
- `apps/web/e2e/fixtures/session.ts` signs an ID token against that key for
  a given role and sets it as the `keki_id_token` cookie on a fresh browser
  context — the same cookie WS-09's session resolution reads.
- `playwright.config.ts`'s `webServer` starts `pnpm dev` with
  `COGNITO_ISSUER` / `COGNITO_JWKS_URI` already pointing at the JWKS server
  above, plus a matching `COGNITO_CLIENT_ID`, `KIOSK_DEVICE_TOKEN`, and both
  database URLs. `NODE_EXTRA_CA_CERTS` points the Next.js process at the
  self-signed certificate so it trusts the JWKS server.

### Prerequisites

- A real Postgres connection: set `DATABASE_URL_POOLED` /
  `DATABASE_URL_DIRECT` before running `pnpm test:e2e` — both the seed
  fixture and the Next.js server under test need one. Playwright refuses to
  start (with a clear error) if either is missing.
- Port `3001` free, for the local JWKS server.
- If you already have `pnpm dev` running in another terminal,
  **stop it first**. With `reuseExistingServer: !process.env.CI`, Playwright
  will happily reuse an already-running dev server locally — but one started
  without the test overrides above will fail every authenticated e2e test in
  a confusing way (valid-looking cookies, session never resolves). This
  exact scenario is what `global-setup.ts`'s startup assertion catches: it
  signs a token and requests a customer page before any spec runs, and fails
  the whole run immediately, with an explanatory message, if the response
  isn't a 200.

Chromium only in Phase 1 (`playwright.config.ts`'s `projects`); Firefox and
WebKit are Phase 2.

### Square stubbing and ordering fixtures

`ordering.spec.ts` (SC-15) covers browse -> add a cafe item -> select a
household child for a class -> cart review -> checkout redirect, and a
price-tamper rejection. It must never contact Square, and the stub it uses
must never be reachable in production:

- `playwright.config.ts`'s `webServer.env` sets `KEKI_ALLOW_SQUARE_STUB=true`
  alongside `NODE_ENV=test`. `apps/web/app/server-clients.ts` (the sole
  composition root for `@keki/square-client`) honors that flag only outside
  production and throws if it is ever set with `NODE_ENV=production` — see
  `server-clients.test.ts`'s "refuses the stub with NODE_ENV=production" and
  test 8 in the WS-12 spec. This is the same pattern
  `@keki/notification-core`'s `createNoopProviders` and the
  `COGNITO_ISSUER`/`COGNITO_JWKS_URI` overrides above already use.
- With the flag set, `getSquareClient()` returns
  `createStubSquareClient()` (`packages/square-client/src/stub.ts`), whose
  `createCheckout` returns a deterministic `checkoutUrl` on
  `https://square.example` — a domain that does not resolve. `apps/web/e2e/fixtures/square-stub.ts`'s
  `interceptSquareCheckout(page)` registers a Playwright route handler for
  that origin *before* the checkout click, so the browser's real navigation
  to it is fulfilled locally instead of failing on DNS resolution. This is
  "an origin the test controls": the app genuinely navigates there, and the
  test decides what happens next, without ever leaving the test environment.
- `playwright.config.ts`'s `webServer.env` also sets `CART_COOKIE_SECRET`
  and `APP_BASE_URL` (both otherwise-required app config — see
  `docs/environment.md`) to fixed test values, exported from
  `fixtures/test-env.ts` so `ordering.spec.ts` can compute a validly-signed
  forged cart cookie for its price-tamper test using the same secret the
  server does.
- `apps/web/e2e/fixtures/seed.ts`'s `seedOrderingFixtures()` (called from
  `global-setup.ts`, after `seedTestUsers()`) idempotently seeds, at fixed
  ids: a published cafe catalog item (`E2E_CAFE_ITEM`), a published class
  offering with a scheduled future occurrence (`E2E_CLASS_OFFERING` /
  `E2E_OCCURRENCE_ID`, `startsAt` refreshed to stay in the future on every
  run), and a child (`E2E_CHILD`) under `TEST_USERS.CUSTOMER`'s household —
  `addChild` is `NotImplementedInPhase1`, so this writes the `children` row
  directly via `@keki/database`, the same exemption `seedTestUsers` uses.
  The occurrence's capacity is set generously high (5000) because, unlike
  `seedTestUsers`, reruns against a persistent (non-CI) branch do
  accumulate reservations against the same fixed occurrence id rather than
  being cleaned up; a capacity in the thousands makes that practically
  irrelevant.
- The journey deliberately books the seeded **child**, not the signed-in
  account holder — a journey that only ever books the account holder would
  pass even if participant selection were broken for the case the product
  exists to serve.
- The price-tamper test adds a real cafe item to the cart through the UI,
  then overwrites the `keki_cart` cookie with one signed using the same
  secret but whose `CATALOG_ITEM` line carries an extra `unitPriceCents`
  field. `cartSchema`'s line schemas are `.strict()` — no price field exists
  to tamper with — so the forged cookie fails schema validation entirely and
  `readCart()` resolves it as empty, not as a cheap-priced cart; checkout is
  rejected with `VALIDATION` and no order row is created. Unit tests already
  cover this at three layers (`cartSchema`, `createOrder`, the cart cookie);
  this proves the layers compose in a running app.

### Sandbox payment-to-fulfillment (SC-20)

`sandbox-fulfillment.spec.ts` is the only test in this program that uses the
**real** Square client end to end: it creates a real order, completes a real
Square **sandbox** payment (via the Payments API's documented
`cnon:card-nonce-ok` test card nonce, not by driving Square's own hosted
checkout UI), delivers a genuinely signed webhook to a **deployed**
`square-webhook` endpoint, and asserts the order reaches `PAID` with its
class reservation `CONFIRMED`. Every other test in this program mocks the
cores or stubs Square; a genuine integration break — a wrong reference
field, a signature mismatch, a payload shape Square actually sends but the
parser rejects — passes every other gate and would only ever surface here.

It is gated on `SQUARE_ACCESS_TOKEN` and self-skips (reported as skipped,
never as passing) without it. It does **not** gate CI: pull-request CI has
no deployed stage to target (see "Deployed-stage tests" below), so
`SQUARE_ACCESS_TOKEN` is deliberately never set as a CI secret. Run it
manually before a production release, pointed at that release's stage:

```sh
export SQUARE_ACCESS_TOKEN=...           # sandbox token for the target stage
export SQUARE_ENVIRONMENT=sandbox
export SQUARE_WEBHOOK_SIGNATURE_KEY=...  # that stage's real signing key
export SQUARE_NOTIFICATION_URL=...       # that stage's deployed square-webhook Function URL
export DATABASE_URL_POOLED=...           # that stage's database — NOT the ephemeral CI branch
export DATABASE_URL_DIRECT=...           # the deployed webhook Lambda writes here, and this test
                                          # must read the same order back from the same place
pnpm exec playwright test sandbox-fulfillment.spec.ts
```

A test that cannot run in CI is still worth having; a claim that it ran when
it did not is not — see "CI" below for how its absence is surfaced rather
than hidden.

## 3. Deployed-stage tests

A small number of WS-11 (Lambda worker) tests are meant to run against a
real, already-deployed AWS stage (SQS, EventBridge, etc.) rather than mocks
or a local Postgres branch — publishing an actual message and confirming a
Lambda drains it, for example. These do **not** run in pull-request CI: no
per-branch deployed stage exists in Phase 1, so there is nothing for them to
target automatically.

They're gated behind `.github/workflows/deployed-stage-tests.yml`, a
`workflow_dispatch`-only workflow that takes a `stage` input and sets
`RUN_DEPLOYED_STAGE_TESTS=true`. The convention for writing one (mirroring
the existing `hasLiveDatabase` pattern used for DB integration tests — see
`packages/customer-core/src/commands.integration.test.ts`):

```ts
const hasDeployedStage = process.env['RUN_DEPLOYED_STAGE_TESTS'] === 'true';
describe.skipIf(!hasDeployedStage)('integration: <feature>', () => {
  /* ... */
});
```

Run manually from the Actions tab (or `gh workflow run deployed-stage-tests.yml -f stage=dev`)
against a stage you've already deployed with `sst deploy --stage <name>`.

## 4. CI

`.github/workflows/ci.yml` runs on every pull request and on push to `main`:

1. Checkout, pnpm + Node setup (Node version from `.nvmrc`, pnpm store cached).
2. `pnpm install --frozen-lockfile` — fails on a lockfile that disagrees with
   the manifests, rather than silently re-resolving.
3. Creates a dedicated Neon branch for the run (`NEON_API_KEY` /
   `NEON_PROJECT_ID` repository secrets) and runs migrations against it.
   **Never the development branch** — concurrent CI runs would corrupt it,
   and `play_pass_ledger`'s append-only trigger makes cleaning up a shared
   branch awkward.
4. `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test`, `pnpm -r build` — in
   that order, identical to `pipeline.config.json`'s `verify` block. This is
   what actually gates CI.
5. Generates a consolidated Vitest JSON report (`pnpm exec vitest run
   --reporter=json --outputFile=vitest-report.json`, i.e. the whole
   `vitest.workspace.ts` workspace in one run) and runs
   `scripts/assert-integration-tests-ran.ts` against it — see "Integration
   test coverage audit" below. Runs after step 4, in this same job, so
   `DATABASE_URL_POOLED`/`DATABASE_URL_DIRECT` are already in scope and every
   `integration:` suite is expected to have actually executed rather than
   skipped.
6. `pnpm exec playwright install chromium`, then `pnpm test:e2e`. Deliberately
   not `--with-deps`: that runs `apt-get` as root to place Chromium's shared
   libraries, which the `ubuntu-latest` image already ships. It once hung on
   an unreachable Ubuntu mirror until the run was cancelled five hours in.
   If a future runner image really is missing a library, add
   `playwright install-deps chromium` as its own step rather than folding apt
   back into the install.
7. Writes a note to the run summary recording whether `SQUARE_ACCESS_TOKEN`
   was set (and therefore whether `sandbox-fulfillment.spec.ts` ran or was
   acknowledged as skipped) — see "Sandbox payment-to-fulfillment" above.
   Never fails the build either way.
8. On failure, uploads `playwright-report/` as a build artifact.
9. Always deletes the Neon branch, whether or not the run succeeded.

The Cognito/JWKS/kiosk env values and both database URLs are exported at job
scope (not only to Playwright's `webServer`), because the build step needs
them too — `next build` loads the same eagerly-validated modules.
`CART_COOKIE_SECRET`, `APP_BASE_URL`, and `KEKI_ALLOW_SQUARE_STUB` are not
needed at job scope: nothing reads them eagerly at module load (unlike
`@keki/auth`/`@keki/database`'s env modules), so `playwright.config.ts`'s
`webServer.env` supplying them only to the spawned dev server is sufficient
— see "Square stubbing and ordering fixtures" above.

## Integration test coverage audit

This program's most important guarantees — capacity under concurrency
(WS-06), schema-level constraints (WS-02), webhook idempotency (WS-10),
catalog sync (WS-04) — live in `describe.skipIf(!hasLiveDatabase)` suites
named `integration: ...`. A CI run where those silently skip (for example,
because a future change to the job accidentally stops exporting
`DATABASE_URL_POOLED`/`DATABASE_URL_DIRECT`) is green and meaningless — the
program's risk register names this failure mode explicitly.

`scripts/assert-integration-tests-ran.ts` parses the Vitest JSON report
generated in CI step 5 above and fails (non-zero exit) when:

- any suite whose name starts with `integration:` reports zero executed
  (non-skipped) tests — unless it is listed in
  `INTENTIONALLY_SKIPPED_IN_CI`, below — or
- any suite named in `REQUIRED_INTEGRATION_SUITES` **or**
  `INTENTIONALLY_SKIPPED_IN_CI` is absent from the report entirely — a
  distinct failure mode from merely skipped, since it catches the suite
  itself being deleted or renamed, not just its precondition going unmet.

`INTENTIONALLY_SKIPPED_IN_CI` names suites whose live dependency this job
deliberately does not provide, so "zero executed" is the expected result
rather than the silent-pass failure the gate exists to catch. It currently
holds one entry: `integration: Square sandbox round trip`
(`packages/square-client/src/checkout.test.ts`), which needs
`SQUARE_ACCESS_TOKEN` — never set as a CI secret, per "Sandbox
payment-to-fulfillment" above, because it makes real calls to Square's
sandbox and gating every pull request on it would put a third party's uptime
in the critical path. The exemption covers *skipping* only: an exempt suite
that disappears still fails the gate, so the escape hatch cannot quietly
become a deletion.

Run it locally against any Vitest JSON report:

```sh
pnpm exec vitest run --reporter=json --outputFile=vitest-report.json
pnpm exec tsx scripts/assert-integration-tests-ran.ts vitest-report.json
```

This converts "the gate cannot fail" into "the gate fails loudly," which is
the point of the risk-register entry. Its own tests
(`scripts/assert-integration-tests-ran.test.ts`) run under
`vitest.workspace.ts` — `scripts/` is not a pnpm workspace package (no
`package.json`, exempt from AGENTS.md's "every package defines all four
scripts" the same way `scripts/deployed-stage-smoke.ts` already is), so it
is registered directly in `vitest.workspace.ts` rather than picked up by
`pnpm -r test`.

Note for future workstreams: a Vitest suite gated behind
`RUN_DEPLOYED_STAGE_TESTS` (see "Deployed-stage tests" above) and named
`integration: ...` will also be flagged by this audit, since pull-request CI
never sets that variable. Add it to `INTENTIONALLY_SKIPPED_IN_CI` rather
than dropping the `integration:` prefix or removing the package from
`vitest.workspace.ts` — both of those hide the suite from the gate
entirely, which means deleting it later would no longer fail CI. The
exemption list keeps that alarm wired up.

### Required repository secrets

| Secret            | Used for                                          |
| ------------------ | -------------------------------------------------- |
| `NEON_API_KEY`      | Creating/deleting the per-run Neon branch          |
| `NEON_PROJECT_ID`   | Which Neon project to branch from                  |

## Database invariant verification (no Neon required)

Two invariants live in hand-edited SQL inside the generated migration rather
than in application code: the `play_pass_ledger` append-only trigger and the
`reservation_participants` "exactly one participant" CHECK constraint. The
Vitest integration suites that cover them are gated behind
`skipIf(!hasLiveDatabase)` and use `@neondatabase/serverless`, which speaks
WebSockets and therefore needs a Neon endpoint (or a WS proxy) — it cannot
talk to a plain Postgres.

`packages/database/scripts/verify-invariants.sql` asserts the same invariants
through `psql`, so they can be checked against **any** Postgres, including a
throwaway local one. Every assertion raises on failure, so a nonzero exit is a
real defect.

Against a local Postgres:

```bash
brew install postgresql@16
export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"
export LC_ALL="en_US.UTF-8"   # required on macOS, or the postmaster aborts
                              # with "became multithreaded during startup"

initdb -D /tmp/keki-pg -U postgres --locale=C -E UTF8
pg_ctl -D /tmp/keki-pg -o "-p 55432 -h 127.0.0.1" -l /tmp/keki-pg.log start
createdb -h 127.0.0.1 -p 55432 -U postgres keki

psql -h 127.0.0.1 -p 55432 -U postgres -d keki -v ON_ERROR_STOP=1 \
  -f packages/database/drizzle/0000_even_blob.sql
psql -h 127.0.0.1 -p 55432 -U postgres -d keki -v ON_ERROR_STOP=1 \
  -f packages/database/scripts/verify-invariants.sql
```

Expect eight `PASS` notices and `ALL INVARIANTS VERIFIED`. Stop the server with
`pg_ctl -D /tmp/keki-pg stop`.

Against a real Neon branch, once `DATABASE_URL_DIRECT` is set:

```bash
pnpm --filter @keki/database db:verify-invariants
```

This is a supplement to the Vitest suites, not a replacement — those also cover
the `FOR UPDATE SKIP LOCKED` outbox claim and webhook idempotency, which need
the application driver and so still require Neon.
