# WS-12: Test harness and CI pipeline

## Goal

Consolidate testing across the workspace and run it in CI: a Vitest workspace
spanning every package, Playwright end-to-end specs covering the four route
groups and the authorization gate, and a GitHub Actions workflow executing
typecheck, lint, test, build, and e2e.

This is where SC-07 is satisfied and where SC-04 and SC-05 acquire automated
proof rather than manual confirmation.

## Traceability

- **SC-07** — Vitest and Playwright both run in CI.
- **SC-04** — Placeholder customer, kiosk, staff, and admin routes all load (asserted by e2e).
- **SC-05** — `staff/` and `admin/` routes require authentication and reject an unauthorized role (asserted by e2e).
- **SC-06** — `pnpm -r typecheck` runs as a CI gate.

## Dependencies

- **WS-09** — Route protection (the behavior the e2e auth specs assert).
- **WS-11** — Lambda workers (the last packages that must be covered).

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Testing" convention: Vitest colocated, Playwright for the four route groups, both in CI
- `docs/vision.md` — "Scope: Phase 1" success criteria
- `package.json` (root) — the four verify scripts CI must run
- `pipeline.config.json` — the `verify` block; CI must run exactly these commands
- `apps/web/app/nav-config.ts` — the routes the e2e specs walk
- `apps/web/app/auth/guards.ts` — `requireRole` and its three redirect destinations
- `packages/auth/src/session.ts` — `SessionResult` and `Session`, for constructing test sessions
- `packages/auth/src/env.ts` — the optional `COGNITO_ISSUER` / `COGNITO_JWKS_URI` overrides the e2e fixtures depend on, and their production guard

## Package

Repository root (`.`) and `apps/web`.

## Files Touched

- `vitest.workspace.ts` (NEW) — workspace-wide Vitest projects
- `playwright.config.ts` (NEW)
- `apps/web/e2e/routes.spec.ts` (NEW) — all eleven placeholder routes
- `apps/web/e2e/auth.spec.ts` (NEW) — the authorization gate
- `apps/web/e2e/fixtures/session.ts` (NEW) — role-scoped session fixtures
- `apps/web/e2e/fixtures/seed.ts` (NEW) — test users and profiles
- `apps/web/e2e/fixtures/jwks-server.ts` (NEW) — local JWKS server and test key pair
- `apps/web/e2e/global-setup.ts` (NEW) — starts the JWKS server before the app
- `apps/web/e2e/global-teardown.ts` (NEW) — stops it
- `.github/workflows/ci.yml` (NEW)
- `package.json` (MODIFY) — add `test:e2e` and coverage scripts
- `apps/web/package.json` (MODIFY) — add `@keki/database` as a **devDependency** for the e2e seed fixture
- `.gitignore` (MODIFY) — confirm `playwright-report/`, `test-results/`, `coverage/`
- `docs/testing.md` (NEW) — how to run each layer locally

## Existing Interfaces to Consume

From `@keki/auth` (WS-04) — the shapes the e2e fixtures must construct to
impersonate a role:

```ts
export type SessionResult =
  | { readonly kind: 'authenticated'; readonly session: Session }
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'unprovisioned'; readonly cognitoSub: string };

export interface CustomerProfile {
  readonly customerId: CustomerId;
  readonly householdId: HouseholdId | null;
  readonly email: string;
  readonly role: Role;
}
```

From WS-09 — the three redirect destinations the auth specs assert:

| Denial reason       | Destination                 |
| ------------------- | --------------------------- |
| `anonymous`         | `/auth/sign-in?next=<path>` |
| `unprovisioned`     | `/auth/complete-profile`    |
| `insufficient_role` | `/auth/unauthorized`        |

The cookie the fixtures set, from `packages/auth/src/cookies.ts`:

```ts
export const ID_TOKEN_COOKIE = 'keki_id_token';
export const KIOSK_DEVICE_COOKIE = 'keki_kiosk_device';
```

## Implementation Steps

1. **Create the Vitest workspace** (`vitest.workspace.ts`) enumerating every
   package's config. This gives one command for the whole repository while
   preserving each package's environment — `@keki/ui` needs `jsdom`, the
   domain packages need `node`.

   Keep `pnpm -r test` as the canonical command, since `pipeline.config.json`
   references it. The workspace file is for local convenience and coverage
   aggregation, not a replacement.

2. **Configure coverage** with the v8 provider, reporting `text` and `lcov`.
   Do **not** set a global coverage threshold in this program. Phase 1 is
   deliberately mostly skeletons and deferred stubs; a percentage gate here
   would either be met by testing `throw NotImplementedInPhase1` repeatedly or
   would fail for entirely correct reasons. Add a `TODO(phase-2)` to introduce
   thresholds once real logic lands.

3. **Build the local JWKS server** (`e2e/fixtures/jwks-server.ts`) before
   configuring Playwright, because the app's environment depends on it.

   Generate an RSA key pair once, persist it to a gitignored scratch file so the
   signing fixture and the server agree, and serve the public JWK set over HTTP
   on a **fixed port** (3001) at `/.well-known/jwks.json`. Export the issuer
   string and the private key for the token-signing fixture.

   Start it from Playwright's `globalSetup` (`e2e/global-setup.ts`) and stop it
   in `globalTeardown`, so it is running before the Next server boots.

   The ordering is the whole point: WS-04 constructs its verifier at module
   scope from environment variables, so the app must **start** with
   `COGNITO_JWKS_URI` already pointing at this server. A Playwright fixture
   cannot retroactively change the environment of a process that is already
   running, so this cannot be done per-test.

4. **Configure Playwright** (`playwright.config.ts`): `apps/web/e2e` as the test
   directory, `globalSetup`/`globalTeardown` pointing at the JWKS server from
   step 3, `baseURL` from an env var defaulting to `http://localhost:3000`,
   Chromium only (add browsers in Phase 2), `trace: 'on-first-retry'`, and
   `retries: process.env.CI ? 2 : 0`.

   The `webServer` block runs `pnpm dev` with an explicit `env` map supplying:

   ```
   NODE_ENV=test
   COGNITO_ISSUER=http://localhost:3001
   COGNITO_JWKS_URI=http://localhost:3001/.well-known/jwks.json
   COGNITO_USER_POOL_ID=<any non-empty test value>
   COGNITO_CLIENT_ID=<must match the aud claim the fixtures sign>
   AWS_REGION=us-east-1
   KIOSK_DEVICE_TOKEN=<value the kiosk fixtures set as the device cookie>
   DATABASE_URL_POOLED=<test branch, pooled>
   DATABASE_URL_DIRECT=<test branch, direct>
   ```

   The three Cognito variables stay **required** even with the overrides set —
   WS-04 validates all of them at module load — so omitting them prevents the
   app from starting at all. `COGNITO_CLIENT_ID` must equal the `aud` the
   session fixtures sign, or every token fails audience validation.
   `KIOSK_DEVICE_TOKEN` must match what the kiosk fixture puts in the device
   cookie, or the kiosk-positive route tests fail.

   Set `reuseExistingServer: !process.env.CI` — and note
   that a locally reused server started _without_ these variables will fail
   every authenticated test confusingly, so `globalSetup` should assert the
   running server is configured for tests before any spec executes.

   WS-04 refuses these overrides when `NODE_ENV === 'production'`. If the app
   fails to start because of that, the guard is working correctly.

5. **Build session fixtures** (`e2e/fixtures/session.ts`). Provide a Playwright
   fixture that, given a `Role`, produces a browser context with a valid ID
   token cookie signed by the step 3 private key, for a seeded user with that
   role.

   Fixtures must set both the cookie and the corresponding Postgres profile via
   `e2e/fixtures/seed.ts`, because WS-04 requires both halves to exist before a
   session resolves — a cookie alone yields `unprovisioned`, not
   `authenticated`.

   Seeding needs `@keki/database`, which WS-08 forbids under `apps/web/app/`.
   That rule is scoped to application source; `apps/web/e2e/` is the explicit
   exemption. Declare `@keki/database` as a **devDependency** of `apps/web` so
   it cannot be pulled into the production bundle, and keep every import of it
   inside `e2e/`.

6. **Write `e2e/routes.spec.ts`.** Assert all eleven placeholder routes load for
   an adequately privileged session:

   - As `CUSTOMER`: `/book`, `/account` return 200 and render an `h1`.
   - With a kiosk device cookie: `/kiosk/book`, `/kiosk/waiver`.
   - As `FRONT_OF_HOUSE`: `/staff/today`, `/staff/check-in`, `/staff/occupancy`.
   - As `MANAGER`: all four `/admin/*` routes.
   - `/` redirects to `/book`.

   Assert each page renders exactly one `h1` and a visible placeholder panel.
   Asserting the placeholder is present is deliberate: it proves the route is
   scaffolded rather than accidentally rendering a blank body.

7. **Write `e2e/auth.spec.ts`.** This is the automated form of SC-05:

   - Anonymous → `/staff/today` redirects to `/auth/sign-in`, and the `next`
     parameter round-trips the original path.
   - Anonymous → `/admin/offerings` redirects to `/auth/sign-in`.
   - `CUSTOMER` → `/staff/today` redirects to `/auth/unauthorized`.
   - `FRONT_OF_HOUSE` → `/admin/offerings` redirects to `/auth/unauthorized`.
   - `FRONT_OF_HOUSE` → `/staff/today` renders.
   - `ADMIN` → `/staff/today` renders (hierarchy).
   - `unprovisioned` → `/account` redirects to `/auth/complete-profile`, **not**
     to sign-in.
   - Kiosk without the device cookie redirects; with it, renders.

   The distinction between "redirected to sign-in" and "redirected to
   unauthorized" is the substance of SC-05. A test that only asserts "did not
   render" would pass even if an authenticated manager were bounced to sign-in.

8. **Write the CI workflow** (`.github/workflows/ci.yml`). Trigger on
   `pull_request` and on push to the default branch. One job with:

   - `actions/checkout`
   - `pnpm/action-setup` and `actions/setup-node` with `cache: 'pnpm'` and the
     version from `.nvmrc`
   - `pnpm install --frozen-lockfile`
   - `pnpm -r typecheck`
   - `pnpm -r lint`
   - `pnpm -r test`
   - `pnpm -r build`
   - `pnpm exec playwright install --with-deps chromium`
   - `pnpm test:e2e`
   - upload `playwright-report/` on failure

   The four middle commands must match `pipeline.config.json`'s `verify` block
   exactly, so CI and the pipeline runner agree on what "passing" means.

   **Supply the full environment to the `build` step, not just to Playwright.**
   `pnpm -r build` runs `next build`, which loads the protected route modules;
   those import `@keki/auth` and `@keki/database`, both of which validate their
   configuration eagerly at module load. With the variables supplied only to
   Playwright's `webServer`, the build fails before e2e ever starts. Export the
   same map used in step 4 — the Cognito values, `AWS_REGION`, the JWKS
   overrides, `KIOSK_DEVICE_TOKEN`, and both database URLs — at job scope so
   every step sees them.

   Use `--frozen-lockfile`: CI must fail on a lockfile that disagrees with the
   manifests rather than silently resolving new versions.

9. **Provision CI's database.** Integration tests from WS-03, WS-06, WS-07, and
   WS-11 need Postgres. Use a dedicated Neon branch per CI run, with
   `DATABASE_URL_POOLED` and `DATABASE_URL_DIRECT` supplied as repository
   secrets, and run migrations before the test step.

   Do not point CI at the development branch — concurrent runs would corrupt one
   another, and the append-only ledger trigger makes cleanup awkward.

   Skip the deployed-stage integration tests (WS-11 tests 16–17) in pull-request
   CI; they require a live AWS stage. Gate them behind a separate manually
   triggered workflow, and say so in `docs/testing.md` rather than letting them
   silently not run.

10. **Document the layers** in `docs/testing.md`: what runs where, how to run
    each locally, which tests need a database, and which need a deployed stage.

11. **Verify.** Run the full sequence locally, then confirm CI passes on a pull
    request.

## Tests

This workstream's deliverable is the test harness; verification is that it runs
and that it fails when it should.

1. **Vitest workspace discovers every package** — Run the workspace config;
   assert the project count equals the number of packages with tests, and that
   no package is silently excluded.
2. **`pnpm -r test` passes** — Assert exit 0 across the workspace.
3. **Playwright config resolves** — Run `pnpm exec playwright test --list`;
   assert it exits 0 and lists both spec files.
4. **All eleven routes load** — The `routes.spec.ts` suite passes (SC-04).
5. **Authorization matrix holds** — The `auth.spec.ts` suite passes, covering
   all eight cases in step 7 (SC-05).
6. **The e2e suite fails when protection is removed** — Temporarily remove
   `requireRole` from the staff layout and assert `auth.spec.ts` fails. A gate
   that cannot fail is not a gate; run this check once and record the result.
7. **Session fixture produces an authenticated session** — Assert a fixture
   context for `MANAGER` resolves as `authenticated`, not `unprovisioned`,
   confirming both cookie and profile are seeded.
   7a. **The e2e server environment is complete** — Assert the Playwright
   `webServer` env map supplies every variable WS-04, WS-03, and WS-09 validate
   at module load: `NODE_ENV`, the two JWKS overrides, all three Cognito
   values, `AWS_REGION`, `KIOSK_DEVICE_TOKEN`, and both database URLs. Assert a
   fixture-signed token verifies against the local key and that its `aud`
   matches `COGNITO_CLIENT_ID`. This is the seam between WS-04's override and
   the fixtures; if it breaks, every authenticated e2e test fails at once.
8. **Unprovisioned fixture is distinguishable** — Assert a fixture with a cookie
   but no profile row yields the `unprovisioned` redirect, not the anonymous
   one.
9. **CI runs the exact verify commands** — Assert `ci.yml` contains
   `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test`, and `pnpm -r build`
   verbatim, matching `pipeline.config.json`.
10. **CI uses a frozen lockfile** — Assert the install step passes
    `--frozen-lockfile`.
    10a. **The build step has the full environment** — Assert the workflow exports
    the Cognito values, `AWS_REGION`, both database URLs, and
    `KIOSK_DEVICE_TOKEN` at job scope, so `pnpm -r build` can load modules that
    validate configuration eagerly. Without this the CI build fails before e2e
    runs.
11. **CI uploads artifacts on failure** — Assert the workflow has an
    `if: failure()` step uploading `playwright-report/`.
    11a. **The database dependency stays test-only** — Assert `@keki/database` is a
    devDependency of `apps/web`, not a dependency, and that no file under
    `apps/web/app/` imports it. This keeps WS-08's boundary intact while making
    the seed fixture possible.
12. **Deployed-stage tests are not silently skipped** — Assert the tests
    requiring a live stage are tagged and excluded explicitly, and that
    `docs/testing.md` records where they run.

## Acceptance Criteria

1. `pnpm -r test` passes across every package in the workspace.
2. `pnpm test:e2e` passes locally against a running dev server.
3. Playwright covers all eleven placeholder routes (step 6) and the full
   authorization matrix (step 7).
4. The e2e auth specs distinguish `sign-in`, `unauthorized`, and
   `complete-profile` redirects rather than asserting only that a page did not
   render.
5. Removing `requireRole` from a protected layout causes `auth.spec.ts` to fail
   (test 6).
6. `.github/workflows/ci.yml` runs typecheck, lint, test, build, and e2e, using
   command strings identical to `pipeline.config.json`'s `verify` block.
7. CI installs with `--frozen-lockfile`, caches the pnpm store, and exports the
   complete environment at job scope so `pnpm -r build` succeeds (test 10a).
8. CI provisions a dedicated Neon branch and runs migrations before tests; it
   does not use the development branch.
9. Tests requiring a deployed AWS stage are explicitly tagged and excluded from
   pull-request CI, with their location documented in `docs/testing.md`.
10. Playwright reports are uploaded as artifacts on failure.
11. No global coverage threshold is configured, and a `TODO(phase-2)` records
    the intent to add one.
12. `docs/testing.md` explains every layer and its prerequisites.
