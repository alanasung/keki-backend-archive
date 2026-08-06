# keki-backend-prod — Program Plan (Phase 1 Scaffold)

## Program Overview

**Product:** Keki is the commerce and operations platform for a cafe that runs
classes, rents rooms, and hosts open play. One Next.js 15 application on AWS
serves four surfaces — customer, kiosk, staff, admin — over a set of plain
TypeScript domain packages, with Square for payments, a waiver provider for
liability signing, and Klaviyo/SES/SMS for customer communication.

**Program scope:** Stand up the complete structural skeleton — monorepo,
database schema, auth wiring, four route groups, asynchronous workers, AWS
provisioning, and CI — with **no booking, payment, waiver, or marketing logic
implemented**. The measure of success is that every seam exists, compiles, and
is exercised end to end by at least one trivial path, so Phase 2 can fill in
behavior without moving structure.

## Strategic Goals

1. **Establish the module boundary before the deployment boundary.** Domain
   logic lives in plain TypeScript packages consumed directly by both Server
   Actions and Lambda handlers, proving that one core serves two runtimes.
2. **Make the data model concrete early.** All thirteen tables exist with
   migrations that run against Neon, so Phase 2 argues about capacity rules
   rather than about schema shape.
3. **Prove the asynchronous path is real.** A message published to SQS is
   consumed by a deployed worker, with a DLQ and an alarm behind it.
4. **Split identity from authorization on day one.** Cognito owns
   authentication; Postgres owns profiles and roles. Retrofitting this split
   later is expensive.
5. **Make verification executable.** `pnpm dev`, migrations, Vitest, and
   Playwright all run — locally and in CI — before any feature work begins.

## Architecture Changes

No `docs/as-built.md` exists; this program creates the system described in
`docs/vision.md` from nothing. The full target architecture:

**Runtime topology.** A single Next.js 15 App Router application deployed via
SST + OpenNext. Four separate Lambda handlers in `functions/` handle
asynchronous work. Both import the same domain packages directly — there is no
internal HTTP hop, and there is deliberately **no Lambda per package**.

**Package graph.** `contracts` sits at the bottom (types, schemas, integration
interfaces) with no internal dependencies. `database` depends on `contracts`.
The five `*-core` packages depend on `contracts` and `database`. `auth` depends
on `contracts` and `database`. `ui` depends on nothing internal. `apps/web` and
`functions/*` sit at the top and may depend on anything below.

**Integration interfaces live in `contracts`.** The brief names five typed
clients — `SquareClient`, `WaiverProvider`, `MarketingProvider`,
`TransactionalEmailProvider`, `SmsProvider` — but the fixed package list has no
home for them. Placing them in `contracts` keeps core packages from depending
on one another (e.g. `reservation-core` needing `commerce-core` only for a
Square type) and preserves the rule that domain code depends on an interface,
never a vendor SDK. Recorded as a decision, not an inference from the brief.

**Data access.** Exclusively through `packages/database` using Drizzle. Neon's
pooled connection string serves application traffic; the direct connection
string serves migrations. These are configured as two distinct secrets and are
not interchangeable.

**Auth.** Cognito User Pool holds credentials and issues tokens. A `customers`
row holds the application profile and role assignment, keyed to the Cognito
subject. Route protection is enforced in middleware plus an explicit role check
at each `staff/` and `admin/` surface.

## Technology Choices

All choices are fixed by `docs/vision.md` and `AGENTS.md`. Three decisions this
program must settle that the brief left open:

| Decision                       | Choice                                                  | Rationale                                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Integration interface location | `packages/contracts`                                    | Avoids core-to-core dependencies; see Architecture Changes.                                                                                                |
| Monorepo task runner           | pnpm workspace recursive (`pnpm -r`) only, no Turborepo | Matches the `verify` commands already in `pipeline.config.json`; adding a build orchestrator is unjustified at nine packages. Revisit if build times bite. |
| CI provider                    | GitHub Actions                                          | Not specified in the brief. Flagged for confirmation — if the team uses something else, WS-12 changes and nothing else does.                               |

## Workstreams

| ID    | Workstream                                               | Dependencies               | Estimated Effort |
| ----- | -------------------------------------------------------- | -------------------------- | ---------------- |
| WS-01 | Monorepo foundation and toolchain                        | —                          | M                |
| WS-02 | `contracts`: domain types and integration interfaces     | WS-01                      | M                |
| WS-03 | `database`: Drizzle schema, migrations, dual connections | WS-02                      | L                |
| WS-04 | `auth`: Cognito identity and Postgres role model         | WS-03                      | M                |
| WS-05 | `ui`: Tailwind preset and shared layout primitives       | WS-01                      | S                |
| WS-06 | Domain cores: reservation, customer, pass                | WS-03                      | M                |
| WS-07 | Domain cores: commerce, notification                     | WS-03                      | M                |
| WS-08 | Next.js app shell and four route groups                  | WS-02, WS-05               | L                |
| WS-09 | Route protection and role gating                         | WS-04, WS-08               | M                |
| WS-10 | SST infrastructure and AWS resources                     | WS-03, WS-04, WS-08, WS-09 | L                |
| WS-11 | Lambda workers and queue wiring                          | WS-07, WS-10               | M                |
| WS-12 | Test harness and CI pipeline                             | WS-09, WS-11               | M                |
| WS-13 | Environment setup documentation                          | WS-10, WS-12               | S                |

**Size key:** S = 1–2 days, M = 3–5 days, L = 5–10 days

### Workstream detail

- **WS-01** — `pnpm-workspace.yaml`, root `package.json`, a shared
  `tsconfig.base.json` that each package extends independently (deliberately
  **not** TypeScript project references — per-package `tsc --noEmit` is what
  makes SC-06's "compiles independently" meaningful), ESLint + Prettier, and the
  four `verify` scripts from
  `pipeline.config.json` (`typecheck`, `lint`, `test`, `build`) wired to resolve
  recursively. This workstream is what makes the configured verify commands
  stop failing; everything after it can be verified.
- **WS-02** — Shared domain types for the thirteen entities, Zod schemas where
  validation crosses a boundary, the four role constants, and the five
  integration interfaces. Types only — no runtime behavior beyond schema
  definitions.
- **WS-03** — Drizzle table definitions for all thirteen tables, relations,
  generated migrations, the pooled/direct connection split, and a `db:migrate`
  script proven against a real Neon branch. Capacity constraints on
  `reservations` are deliberately left out. `play_pass_ledger` is defined
  append-only.
- **WS-04** — Cognito User Pool client configuration, token verification,
  session helpers, and the profile/role lookup that joins a Cognito subject to
  a `customers` row. Defines the four roles and the authorization predicate;
  does not apply it to routes.
- **WS-05** — Tailwind 4 configuration shared across the workspace, plus the
  shared navigation component and layout primitives the four route groups need.
  Presentational only.
- **WS-06** — Package skeletons for `reservation-core`, `customer-core`, and
  `pass-core`: public surface, service module shape, and unit test scaffolding.
  No booking capacity logic and no pass draw-down.
- **WS-07** — Package skeletons for `commerce-core` and `notification-core`,
  including the outbox write path shape that WS-11's worker will drain. No
  Square checkout, no Klaviyo flows.
- **WS-08** — `apps/web` with the `(customer)`, `kiosk`, `staff`, and `admin`
  route groups, every placeholder page named in the brief, root layout, and
  shared navigation consumed from `ui`. Placeholder content only.
- **WS-09** — Middleware and per-surface role checks so `staff/` and `admin/`
  require authentication, `(customer)` requires a customer session, and `kiosk`
  follows the device-session model. Covered by Playwright specs in WS-12.
- **WS-10** — SST v3 app definition: OpenNext deployment, four SQS queues each
  with a DLQ, EventBridge Scheduler execution role, private S3 document bucket,
  Cognito User Pool, secrets for Neon/Square/Klaviyo/waiver credentials, and
  CloudWatch alarms on queue failure. `sst dev` must link successfully.
- **WS-11** — The four handlers in `functions/`, each importing domain packages
  directly, wired to their queues with DLQ redrive. Includes the publish/consume
  round trip that satisfies SC-08.
- **WS-12** — Vitest projects across all packages, Playwright specs covering the
  four route groups and the auth gate, and a CI workflow running typecheck,
  lint, test, build, and e2e.
- **WS-13** — README covering local setup, the two Neon connection strings,
  required secrets, `sst dev` linking, and how to run each verify command.

## Dependency Graph

```
                       WS-01 (foundation)
                      /                  \
                 WS-02 (contracts)      WS-05 (ui)
                  /     \                 /
                 /       \               /
    WS-03 (database)      WS-08 (app shell)
     /    |    \                |      \
WS-04  WS-06  WS-07             |       \
  |  \         |                |        \
  |   +--------|----------> WS-09         \
  |            |                |          \
  +------------|----------------|--------> WS-10 (SST)
               |                |              |
               +----------------|----------> WS-11 (workers)
                                |              |
                                +------+-------+
                                       |
                                    WS-12 (test + CI)
                                       |
                                    WS-13 (docs)

WS-08 depends on WS-02 and WS-05.
WS-09 depends on WS-04 and WS-08.
WS-10 depends on WS-03, WS-04, WS-08, and WS-09.
WS-11 depends on WS-07 and WS-10.
WS-12 depends on WS-09 and WS-11.
WS-13 depends on WS-10 and WS-12.
```

Parallelism: after WS-02, the `WS-03` spine and the `WS-08` app shell run
independently. WS-04, WS-06, and WS-07 fan out from WS-03 and can run
concurrently. WS-08 has roughly four days of slack; WS-05, WS-06, and WS-07 have
more.

## Critical Path

```
WS-01 → WS-02 → WS-03 → WS-04 → WS-09 → WS-10 → WS-11 → WS-12 → WS-13
```

Roughly 40.5 working days serialized.

The path runs through the **data and identity spine into infrastructure**, not
through the UI. WS-10 cannot start until WS-03, WS-04, and WS-09 exist, because
resource linking must satisfy every environment contract they define — the two
Neon connection strings with the swap guard, the Cognito variables, and
`KIOSK_DEVICE_TOKEN`. WS-08 is not on the path: it finishes around day 15.5
while WS-10 waits on WS-09 until day 23.5.

Only `WS-05` and the `WS-06`/`WS-07` fan-out carry real slack. The
`WS-02 → WS-03 → WS-04 → WS-09` chain does not — every day lost there is a day
lost overall.

**Schedule risk concentrates in WS-10 and its upstream.** WS-10 is the
workstream most likely to exceed its estimate (unfamiliar SST v3 surface, AWS
account prerequisites) and it sits on the critical path with WS-11, WS-12, and
WS-13 queued behind it. Two compressions are available and cheap:

1. Complete WS-10's AWS account, region bootstrap, and credential prerequisites
   during WS-03 — they depend on nothing in this repository.
2. Treat WS-03 (L, 7.5 days) as the schedule's real pressure point. It is the
   longest task on the critical path and everything downstream inherits its
   slip.

## Scope (In)

- pnpm workspace monorepo with nine packages, one app, four functions
- Drizzle schema and runnable migrations for all thirteen tables
- Neon pooled/direct connection split
- Cognito User Pool with four scaffolded roles; Postgres-owned profiles
- Next.js app with all placeholder routes and shared navigation
- Authentication gate on `staff/` and `admin/`
- Five typed integration interfaces, no production implementations
- SST provisioning of OpenNext, SQS + DLQs, EventBridge Scheduler role, S3
  document bucket, secrets, and CloudWatch alarms
- Four Lambda workers with a proven publish/consume round trip
- Vitest and Playwright running in CI
- README environment setup documentation

## Scope (Out)

Explicitly deferred to Phase 2 — do not implement in this program:

- Reservation capacity and booking logic
- Square checkout and payment reconciliation
- Waiver signing end to end
- Klaviyo flows and marketing automation
- Play-pass draw-down at check-in
- Webflow content
- Production implementations behind any of the five integration interfaces
- A public REST API
- Real occupancy calculation on `staff/occupancy`

## Risk Register

| Risk                                                               | Impact                                                                       | Mitigation                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WS-10 overruns and blocks the four workstreams behind it           | High — direct critical-path slip                                             | Provision the AWS account, Cognito pool, and secrets during WS-08; treat SST linking as WS-10's first deliverable, not its last.                                                                                                                            |
| Schema scaffolded without capacity rules bakes in wrong shapes     | High — Phase 2 migration churn on `reservations`                             | Model `reservations`/`reservation_participants` for the known access patterns and leave capacity as an explicit `TODO(phase-2)`; review the schema with the Phase 2 booking rules in hand before WS-06 closes.                                              |
| Domain cores drift into implementing logic that is out of scope    | Medium — burns Phase 1 budget, pre-commits Phase 2 design                    | WS-06/WS-07 deliver public surface and tests only; reviewers reject non-trivial function bodies.                                                                                                                                                            |
| `claude` and `codex` CLIs are absent from the build machine        | High — pipeline cannot execute at all                                        | Install and authenticate both before invoking `build-program`; see the init report.                                                                                                                                                                         |
| `verify` commands in `pipeline.config.json` fail until WS-01 lands | Medium — first workstream cannot self-verify                                 | WS-01 is the workstream that creates them; run it interactively rather than through the automated runner.                                                                                                                                                   |
| Kiosk auth model is unspecified (shared device, non-account-first) | Medium — WS-09 could design the wrong gate                                   | Resolve the kiosk session model before WS-09 begins; it is assumption #3 in `docs/vision.md`.                                                                                                                                                               |
| Cognito/Postgres role split is applied inconsistently              | Medium — authorization bugs that survive into production                     | WS-04 exposes exactly one authorization predicate; WS-09 must call it rather than reading tokens directly.                                                                                                                                                  |
| CI provider assumed to be GitHub Actions                           | Low — WS-12 rework only                                                      | Confirm before WS-12; no other workstream is affected.                                                                                                                                                                                                      |
| Webhook signature verification is the one SC-11 exception          | Medium — a real Square integration will not work until Phase 2               | Phase 1 implements generic HMAC, not Square's URL-plus-body construction. The Function URL is therefore `AWS_IAM`-authed and not publicly reachable, so no unverifiable traffic can arrive. Phase 2 must implement the real scheme before making it public. |
| Notification outbox leases can strand on a worker crash            | Medium — a customer message silently never sends                             | `CLAIMED` rows carry `claimed_at`/`claimed_by`; WS-07's `reclaimStaleClaims` reaper returns them to `PENDING` and increments `attempts` so they eventually dead-letter rather than cycling.                                                                 |
| Test-only JWKS override becomes an auth bypass                     | High if it reaches production — anyone who can set the variable mints tokens | `COGNITO_ISSUER`/`COGNITO_JWKS_URI` are refused when `NODE_ENV === 'production'`, asserted by WS-04 test 15.                                                                                                                                                |

## Success Criteria

| ID    | Outcome                                                                                                                                                                                  |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SC-01 | `pnpm dev` runs the Next.js application locally.                                                                                                                                         |
| SC-02 | `sst dev` links the application to its AWS resources.                                                                                                                                    |
| SC-03 | Neon migrations run successfully using the direct connection string.                                                                                                                     |
| SC-04 | Placeholder customer, kiosk, staff, and admin routes all load.                                                                                                                           |
| SC-05 | `staff/` and `admin/` routes require authentication and reject an unauthorized role.                                                                                                     |
| SC-06 | Every shared package compiles independently (`pnpm -r typecheck` passes).                                                                                                                |
| SC-07 | Vitest and Playwright both run in CI.                                                                                                                                                    |
| SC-08 | A sample message published to SQS is consumed by its deployed worker.                                                                                                                    |
| SC-09 | Environment setup is documented in the repository README.                                                                                                                                |
| SC-10 | All thirteen Drizzle tables exist with generated, applied migrations.                                                                                                                    |
| SC-11 | All five integration interfaces are defined and referenced, with no production implementation — except webhook signature verification, the one deliberate exception (see Risk Register). |
| SC-12 | The four roles exist, with Cognito holding identity and Postgres holding profile and role assignment.                                                                                    |
| SC-13 | Application traffic uses the pooled connection string and migrations use the direct one, configured as separate secrets.                                                                 |
| SC-14 | Every SQS queue has a DLQ and a CloudWatch failure alarm.                                                                                                                                |
