# keki-backend-prod — As-Built System Snapshot

<!-- Last updated: 2026-08-06 after program: phase-1-scaffold -->

Structural skeleton only: every seam exists, compiles, and is exercised by at
least one trivial path. All domain *commands* deliberately reject with
`NotImplementedInPhase1` (see Known Limitations).

## Packages & Key Exports

pnpm workspace: `apps/*`, `packages/*`, `functions/*`, `infra`. All internal
packages are consumed as source (`main`/`exports` → `./src/index.ts`); their
`build` script is `tsc --noEmit`, not an emit step.

### @keki/contracts (packages/contracts)

Bottom of the dependency graph; no internal dependencies.
Key exports: entity interfaces for all 13 tables (`Customer`, `Reservation`,
`PlayPass`, …); status constant arrays + types (`ROLES`, `RESERVATION_STATUSES`,
`PAYMENT_STATUSES`, `NOTIFICATION_STATUSES`, …); `hasAtLeastRole()` role-rank
predicate; Zod schemas (`createReservationSchema`, `registerCustomerSchema`);
the five integration interfaces (`SquareClient`, `WaiverProvider`,
`MarketingProvider`, `TransactionalEmailProvider`, `SmsProvider`); versioned
queue-message envelopes + schemas (`NotificationMessage`,
`ReconciliationMessage`, scheduled-task and Square webhook messages);
`NotImplementedInPhase1` error.

### @keki/database (packages/database)

Key exports: `db`, `schema` (Drizzle client over `@neondatabase/serverless`).
`src/env.ts` validates the pooled/direct connection split eagerly at module
load; `src/migrate.ts` runs migrations over the direct URL (`db:migrate`).
Schema lives in `src/schema/*` (see Data Model). One generated migration
(`drizzle/0000_even_blob.sql`) with two hand-written additions: the `citext`
extension and the `play_pass_ledger` append-only BEFORE UPDATE/DELETE trigger.

### @keki/auth (packages/auth)

Key exports: `verifyToken` (Cognito JWT), `resolveSession`, `authorize`
(the single authorization predicate), `findProfileByCognitoSub`,
`extractToken` / `ID_TOKEN_COOKIE_NAME`, typed errors (`AuthConfigError`,
`InvalidTokenError`, `ProfileNotFoundError`). Cognito owns identity; the
`customers` row (keyed by `cognito_sub`) owns profile and role.
`COGNITO_ISSUER`/`COGNITO_JWKS_URI` test overrides are refused when
`NODE_ENV === 'production'`.

### Domain cores (all depend on contracts + database only)

- **@keki/reservation-core** — queries plus `holdReservation`,
  `confirmReservation`, `cancelReservation` (all Phase-1 stubs).
- **@keki/customer-core** — `getCustomerById`, `getHouseholdById`,
  `listHouseholdMembers`, `provisionCustomerProfile` (real); `addChild`,
  `updateHousehold`, `startWaiverSigning` (stubs).
- **@keki/pass-core** — `getPassBalance`, `computeBalance` (ledger replay,
  real); `issuePass`, `redeemCredits`, `expirePass` (stubs).
- **@keki/commerce-core** — `recordPaymentFromWebhook` (real, idempotent on
  `provider_payment_id`), payment queries; `startCheckout`, `capturePayment`,
  `refundPayment` (stubs).
- **@keki/notification-core** — transactional outbox: `enqueueNotification`,
  `claimDueNotifications`, `markNotificationSent` / `markNotificationFailed`,
  `reclaimStaleClaims` (crash-lease reaper), `dispatchNotification`,
  `createNoopProviders`.

### @keki/ui (packages/ui)

Key exports: `SurfaceNav`, `PageShell`, `PlaceholderPanel`, `cn`. Tailwind 4
preset shared across the workspace. Presentational only.

### web (apps/web)

Next.js 15 App Router app; four surfaces (see API Endpoints). `middleware.ts`
plus `app/auth/guards.ts` enforce the auth gate; role checks call
`@keki/auth`'s `authorize`. No Server Actions exist yet (`'use server'`
appears nowhere) — pages are placeholders.

### functions/* (four Lambda workers)

Each imports domain packages directly (no internal HTTP hop):

- **notification-worker** — drains the outbox: reclaims stale claims (15-min
  window), claims due rows, dispatches via no-op providers.
- **reconciliation-worker** — validated skeleton only; parses the message and
  returns batch failures. Real Square reconciliation is Phase 2.
- **scheduled-task-worker** — receives EventBridge Scheduler-shaped messages;
  known task keys re-enqueue a notification drain; unknown keys log-and-drop
  (deliberately open envelope).
- **square-webhook** — Lambda Function URL handler (`http.ts`) verifies an
  HMAC signature, enqueues to SQS; `consumer.ts` records payments via
  commerce-core. URL is `AWS_IAM`-authed, not public (see Known Limitations).

### infra (infra/)

SST v3 component modules invoked from `sst.config.ts` via dynamic import:
`createSecrets`, `createDocumentsBucket`, `createAuth` (Cognito User Pool),
`createQueues` / `attachWorkers`, `createAlarms`, `createSchedulerRole`,
`createWeb` (OpenNext). Exports `webUrl`, `bucketArn`, `userPoolId`,
`squareWebhookUrl`.

## Data Model

13 Postgres tables (Neon), all defined in `packages/database/src/schema/`.
Every table has uuid PK (`defaultRandom`) and timestamptz timestamps unless
noted. Enum values come from `@keki/contracts` constants.

| Table | Columns (beyond id/timestamps) |
| --- | --- |
| `households` | name, primary_customer_id FK→customers (circular, emitted as post-hoc ALTER) |
| `customers` | household_id FK, cognito_sub (unique, Cognito join key), email citext unique, phone, first/last_name, role enum (default CUSTOMER), status |
| `children` | household_id FK, first/last_name, date_of_birth, notes |
| `offerings` | slug unique, name, description, type enum (CLASS/ROOM/OPEN_PLAY), duration_minutes, default_capacity, price_cents, currency char(3), status enum (DRAFT/PUBLISHED/ARCHIVED) |
| `occurrences` | offering_id FK, starts_at/ends_at timestamptz, capacity_override, status enum; indexes on starts_at and (offering_id, starts_at) |
| `reservations` | occurrence_id, household_id, created_by_customer_id FKs, status enum (HELD/CONFIRMED/CHECKED_IN/CANCELLED/NO_SHOW), hold_expires_at, notes; index (occurrence_id, status). No capacity constraint yet — Phase 2 |
| `reservation_participants` | reservation_id FK (cascade), customer_id XOR child_id (CHECK constraint mirrors the contracts discriminated union), waiver_record_id FK, checked_in_at |
| `play_passes` | household_id FK, offering_id FK, total/remaining_credits, purchased_at, expires_at, status |
| `play_pass_ledger` | **append-only** (DB trigger): play_pass_id FK, delta_credits, reason enum (PURCHASE/REDEMPTION/ADJUSTMENT/EXPIRY/REFUND), reservation_id, actor_customer_id, occurred_at, metadata jsonb; index (play_pass_id, occurred_at) |
| `payment_records` | household_id FK, reservation_id FK, provider (default SQUARE), provider_payment_id unique (webhook idempotency key), amount_cents, currency, status enum (PENDING/AUTHORIZED/CAPTURED/REFUNDED/FAILED), raw_payload jsonb, occurred_at |
| `notification_outbox` | channel enum (EMAIL/SMS/MARKETING), template_key, recipient_customer_id FK, recipient_address, payload jsonb, status enum (PENDING/CLAIMED/SENT/FAILED/DEAD), attempts, available_at, claimed_at/claimed_by (crash lease), sent_at, last_error; index (status, available_at) |
| `waiver_records` | provider, provider_reference unique (idempotency key), household_id FK, customer_id / child_id FKs, signed_at, expires_at, document_s3_key, status enum (SIGNED/EXPIRED/REVOKED) |
| `staff_audit_log` | actor_customer_id FK, action, entity_type, entity_id, before/after jsonb, occurred_at, ip_address inet |

Connections: application traffic uses the Neon **pooled** URL
(`NeonPooledUrl`); migrations use the **direct** URL (`NeonDirectUrl`). The
two are separate secrets and not interchangeable.

## API Endpoints

No REST API and no Server Actions exist. Surfaces are Next.js pages
(placeholder content), gated by `middleware.ts` + `app/auth/guards.ts`:

**Customer `(customer)`** (session required): `/account`, `/book`
**Kiosk `/kiosk`** (shared `KIOSK_DEVICE_TOKEN` device session): `/kiosk/book`, `/kiosk/waiver`
**Staff `/staff`** (role ≥ FRONT_OF_HOUSE): `/staff/check-in`, `/staff/occupancy` (fake data), `/staff/today`
**Admin `/admin`** (role ≥ MANAGER/ADMIN checks): `/admin/customers`, `/admin/offerings`, `/admin/reservations`, `/admin/schedules`
**Auth**: `/auth/sign-in`, `/auth/complete-profile`, `/auth/unauthorized`
**Public**: `/` (root landing)

One HTTP ingress outside Next.js: the `square-webhook` Lambda Function URL
(IAM-authed, not publicly reachable in Phase 1).

## Protocols / Events

All queue messages share a versioned envelope
(`{ version: 1, type, occurredAt, payload }`) with Zod schemas in
`@keki/contracts`:

- `notification.drain` → NotificationQueue → notification-worker
- `reconciliation.run` → ReconciliationQueue → reconciliation-worker
- scheduled-task messages (open `taskKey` string) → ScheduledTaskQueue → scheduled-task-worker
- Square webhook envelope (verified HMAC) → SquareWebhookQueue → square-webhook consumer

Notification delivery uses the `notification_outbox` table as a transactional
outbox with a CLAIMED lease state; abandoned claims are reaped back to
PENDING and eventually dead-letter via `attempts`.

## Infrastructure

- **SST v3** (`sst.config.ts`, app name `keki`, region `us-east-1`;
  production stage is `retain`+`protect`). All resources come from `infra/`
  modules — nothing hand-created in the console.
- **OpenNext** deployment of `apps/web` via `sst.aws.Nextjs` (bundled
  OpenNext, no separate version pin).
- **Four SQS queues** — SquareWebhookQueue, NotificationQueue,
  ReconciliationQueue, ScheduledTaskQueue — each with a DLQ (14-day
  retention), visibility timeout = 6× consumer timeout, and CloudWatch
  alarms on DLQ depth and oldest-message age.
- **Cognito User Pool** per stage (`keki-{stage}`).
- **EventBridge Scheduler** execution role targeting ScheduledTaskQueue.
- **Private S3 bucket** for waiver documents.
- **Secrets** (`sst.Secret`): NeonPooledUrl, NeonDirectUrl,
  SquareAccessToken, SquareWebhookSignatureKey, KlaviyoApiKey,
  WaiverProviderApiKey, KioskDeviceToken.
- **CI** (`.github/workflows/ci.yml`): pnpm install → per-run Neon test
  branch → typecheck, lint, test, build, Playwright e2e. Workspace
  concurrency is capped (perf fix, commit 98949b9). A scheduled workflow
  sweeps leaked `ci-*` Neon branches.
- **CD** (`.github/workflows/deploy.yml`): production deploys are
  tag-triggered (`v*`) only — `production` GitHub Environment approval,
  OIDC-assumed role (no stored keys), CI-passed check, `db:migrate`,
  `sst deploy --stage production`, then an SQS round-trip smoke test
  (`scripts/deployed-stage-smoke.ts`). Laptop production deploys are
  refused by a stage guard in `sst.config.ts`
  (`KEKI_ALLOW_LOCAL_PROD_DEPLOY=1` break-glass); `infra/index.ts` asserts
  the target account is `495504746201`. `deployed-stage-tests.yml` runs the
  same smoke test against any stage on demand.
- **Verification scripts**: every workspace package defines `typecheck`,
  `lint`, `test`, `build` (bare `pnpm -r`, no `--if-present`).

## Known Limitations / Tech Debt

Phase-2 candidates, marked `TODO(phase-2)` in source:

- **All domain commands are stubs** rejecting `NotImplementedInPhase1`:
  reservations (hold/confirm/cancel), passes (issue/redeem/expire), commerce
  (checkout/capture/refund), customer (addChild/updateHousehold/
  startWaiverSigning). Queries and the outbox/payment-recording paths are real.
- **No reservation capacity enforcement** — the partial unique index /
  exclusion constraint on `reservations(occurrence_id)` is deferred.
- **Webhook signature verification is generic HMAC-SHA256**, not Square's
  URL-plus-body scheme; safe only because the Function URL is IAM-authed.
  Must be fixed before the endpoint goes public.
- **reconciliation-worker is a skeleton** — no comparison against Square or
  reservation state.
- **Kiosk auth is a shared static device token** — adequate for Phase 1 only.
- **Notification providers are no-ops** (`createNoopProviders`) — no real
  SES/SMS/Klaviyo integration behind the five interfaces.
- **`/staff/occupancy` renders fake data**.
- **No Server Actions** — pages are placeholders; every surface needs real
  behavior in Phase 2.

## Programs Completed

1. `phase-1-scaffold` — structural skeleton: monorepo, 13-table Drizzle
   schema, Cognito/Postgres auth split, four route groups, SST-provisioned
   AWS resources, four SQS workers, Vitest + Playwright CI. Built 2026-08-04
   → 2026-08-06 (all 13 workstreams complete).
