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
placeholder routes — SC-04) and the authorization gate (`auth.spec.ts`, the
full `staff/`/`admin/` role matrix — SC-05).

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
   that order, identical to `pipeline.config.json`'s `verify` block.
5. `pnpm exec playwright install --with-deps chromium`, then `pnpm test:e2e`.
6. On failure, uploads `playwright-report/` as a build artifact.
7. Always deletes the Neon branch, whether or not the run succeeded.

The Cognito/JWKS/kiosk env values and both database URLs are exported at job
scope (not only to Playwright's `webServer`), because the build step needs
them too — `next build` loads the same eagerly-validated modules.

### Required repository secrets

| Secret            | Used for                                          |
| ------------------ | -------------------------------------------------- |
| `NEON_API_KEY`      | Creating/deleting the per-run Neon branch          |
| `NEON_PROJECT_ID`   | Which Neon project to branch from                  |
