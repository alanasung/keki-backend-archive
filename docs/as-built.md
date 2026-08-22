# keki-backend-prod — As-Built System Snapshot

<!-- Last updated: 2026-08-21 after program: phase-3-admin-catalog -->

Two domains are now real end to end: **ordering** (`phase-2-square-ordering`)
— browse the cafe menu and classes, cart, Square checkout, webhook-recorded
payment, order history — and **admin catalog management**
(`phase-3-admin-catalog`) — managers create, publish, and schedule classes
through `/admin`, with every mutation audited in `staff_audit_log`. Not every
domain command is a stub anymore; see Known Limitations for what still is
(play passes, waivers, payment capture/refund, kiosk, notification delivery).

## Packages & Key Exports

pnpm workspace: `apps/*`, `packages/*`, `functions/*`, `infra`. All internal
packages are consumed as source (`main`/`exports` → `./src/index.ts`); their
`build` script is `tsc --noEmit`, not an emit step.

### @keki/contracts (packages/contracts)

Bottom of the dependency graph; no internal dependencies.
Key exports: entity interfaces for all 16 tables (`Customer`, `Reservation`,
`PlayPass`, `Order`, `CatalogItem`, …); status constant arrays + types
(`ROLES`, `RESERVATION_STATUSES`, `PAYMENT_STATUSES`, `NOTIFICATION_STATUSES`,
`ORDER_STATUSES`, `OFFERING_STATUSES`, …); transition tables
(`OFFERING_TRANSITIONS`, `ORDER_TRANSITIONS`) and `AUDIT_ACTIONS`
(`phase-3-admin-catalog`); `hasAtLeastRole()` role-rank predicate; Zod schemas
(`createReservationSchema`, `registerCustomerSchema`, `cartSchema`,
`createOfferingSchema`, `scheduleOccurrenceSchema`, …); the five integration
interfaces (`SquareClient`, `WaiverProvider`, `MarketingProvider`,
`TransactionalEmailProvider`, `SmsProvider`); versioned queue-message
envelopes + schemas (`NotificationMessage`, `ReconciliationMessage`,
scheduled-task and Square webhook messages); `NotImplementedInPhase1` error.

### @keki/database (packages/database)

Key exports: `db`, `schema`, `withTransaction` (Drizzle client over
`@neondatabase/serverless`). `src/env.ts` validates the pooled/direct
connection split eagerly at module load; `src/migrate.ts` runs migrations
over the direct URL (`db:migrate`). Schema lives in `src/schema/*` (see Data
Model). Three migrations: `0000_even_blob.sql` (the `citext` extension and
the `play_pass_ledger` append-only BEFORE UPDATE/DELETE trigger, both
hand-written), `0001_chief_gressill.sql` (`phase-2-square-ordering`'s
`catalog_items`, `orders`, `order_line_items` tables), and
`0002_capacity_constraint.sql` (hand-written: the `reservations_capacity_check`
BEFORE INSERT/UPDATE trigger — locks the occurrence row with
`FOR UPDATE`, sums active (`HELD`/`CONFIRMED`/`CHECKED_IN`) seats, and raises
SQLSTATE `KEKI1` over capacity, so concurrent bookings for the same
occurrence serialize instead of racing).

### @keki/catalog-core (packages/catalog-core)

`phase-2-square-ordering`. Depends on contracts + database only. Key
exports: `listCafeItems`, `listBookableOfferings` (the customer-facing
`/book` query — published offerings with a scheduled future occurrence,
joined against seat-consuming reservations for a live `seatsRemaining`),
`syncCatalog` (paginates Square's Catalog API for cafe items, then
upserts/archives in one Neon batch — off the render path, run on a
schedule by `functions/scheduled-task-worker`).

### @keki/catalog-admin (packages/catalog-admin)

`phase-3-admin-catalog`. Depends on contracts + database only; never
imported by `apps/web/app/(customer)/` or `apps/web/app/kiosk/` (enforced by
`package-boundaries.test.ts`). Key exports: `createOffering`,
`updateOffering`, `transitionOffering` (the DRAFT/PUBLISHED/ARCHIVED state
machine — `OFFERING_TRANSITIONS` in `@keki/contracts`); `scheduleOccurrence`,
`updateOccurrence`, `cancelOccurrence` (refuses to cancel an occurrence with
active reservations); `listOfferings`, `listUpcomingOccurrences` (the
admin-side views, including live `bookedSeats`); `recordAuditEntry` — every
command above calls it in the **same transaction** as its own mutation
(`withTransaction`), so a rolled-back mutation leaves no `staff_audit_log`
row either; `staff_audit_log` had no writer before this program (see
Known Limitations in the prior snapshot). `generateUniqueSlug`/`slugify` for
offering slugs.

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
  `confirmReservation`, `cancelReservation` (real as of
  `phase-2-square-ordering` — the capacity trigger above is what makes
  `holdReservation` safe under concurrency; a `capacity_exceeded` Postgres
  error surfaces as a typed domain error).
- **@keki/customer-core** — `getCustomerById`, `getHouseholdById`,
  `listHouseholdMembers`, `provisionCustomerProfile` (real); `addChild`,
  `updateHousehold`, `startWaiverSigning` (still Phase-1 stubs — waiver
  signing is Phase 2+ per `docs/vision.md`).
- **@keki/pass-core** — `getPassBalance`, `computeBalance` (ledger replay,
  real); `issuePass`, `redeemCredits`, `expirePass` (still stubs — play
  passes are Phase 2+).
- **@keki/commerce-core** — `recordPaymentFromWebhook` (real, idempotent on
  `provider_payment_id`), `createOrder`, `transitionOrder`, payment/order
  queries, `startCheckout` (real as of `phase-2-square-ordering` — builds a
  Square checkout link from the order's persisted line items, idempotent on
  the order id); `capturePayment`, `refundPayment` remain stubs (the
  checkout-link flow never calls them directly; out of scope until refunds
  are).
- **@keki/notification-core** — transactional outbox: `enqueueNotification`,
  `claimDueNotifications`, `markNotificationSent` / `markNotificationFailed`,
  `reclaimStaleClaims` (crash-lease reaper), `dispatchNotification`,
  `createNoopProviders`. Still no real caller enqueues an order or booking
  confirmation — see Known Limitations.

### @keki/ui (packages/ui)

Key exports: `SurfaceNav`, `PageShell`, `PlaceholderPanel`, `EmptyState`,
`StatusBadge`, `Price`, `FormField`, `CatalogItemCard`,
`ParticipantChecklist`, `cn`. Tailwind 4 preset shared across the workspace.
Presentational only — no data fetching, no Server Action imports (see
`catalog-item-card.tsx`'s own doc comment).

### web (apps/web)

Next.js 15 App Router app; four route groups (see API Endpoints).
`middleware.ts` plus `app/auth/guards.ts` enforce the auth gate; role checks
call `@keki/auth`'s `authorize`. Server Actions now exist throughout —
`apps/web/app/actions/authenticated-action.ts` is the one authorization
boundary every mutation goes through (session resolution, `requiredRole`,
Zod parse, typed `ActionResult`), consumed both by the customer cart/checkout
actions and by `app/admin/actions/*` (the MANAGER boundary
`phase-3-admin-catalog` built on top of it). `apps/web/app/server-clients.ts`
is the sole composition root for `@keki/square-client`, honoring
`KEKI_ALLOW_SQUARE_STUB` outside production only.

Customer surface is no longer placeholder-only: `/book` (cafe items +
bookable classes, live seat counts), `/cart` (cookie-backed, HMAC-signed),
`/checkout/mock/[orderId]` (a local stand-in for Square's hosted checkout
page in dev), `/orders/[orderId]`. Admin surface
(`phase-3-admin-catalog`): `/admin/offerings` (create/edit/publish/archive),
`/admin/schedules` (schedule/edit-capacity/cancel occurrences),
`/admin/reservations` (per-occurrence roster), `/admin/customers`
(placeholder still — out of this program's scope).

### functions/* (four Lambda workers)

Each imports domain packages directly (no internal HTTP hop):

- **notification-worker** — drains the outbox: reclaims stale claims (15-min
  window), claims due rows, dispatches via no-op providers (still no-op —
  see Known Limitations).
- **reconciliation-worker** — still a validated skeleton only; parses the
  message and returns batch failures. Real Square reconciliation remains
  unbuilt.
- **scheduled-task-worker** — receives EventBridge Scheduler-shaped messages;
  known task keys re-enqueue a notification drain or run `syncCatalog`
  (`phase-2-square-ordering`); unknown keys log-and-drop (deliberately open
  envelope).
- **square-webhook** — Lambda Function URL handler (`http.ts`) verifies
  Square's real signature scheme (`@keki/square-client`'s
  `verifySquareSignature`: HMAC-SHA256 over `notificationUrl + rawBody`,
  base64, `timingSafeEqual` comparison — no longer generic HMAC), enqueues to
  SQS; `consumer.ts` records payments via `commerce-core.recordPaymentFromWebhook`.
  The Function URL is now public (`authType: "none"`) — the real signature
  scheme is what makes that safe; `infra/queues.ts` asserts the configured
  `SquareNotificationUrl` secret matches the deployed URL on every deploy.

### infra (infra/)

SST v3 component modules invoked from `sst.config.ts` via dynamic import:
`createSecrets`, `createDocumentsBucket`, `createAuth` (Cognito User Pool),
`createQueues` / `attachWorkers`, `createAlarms`, `createSchedulerRole`,
`createWeb` (OpenNext). Exports `webUrl`, `bucketArn`, `userPoolId`,
`squareWebhookUrl`.

## Data Model

16 Postgres tables (Neon), all defined in `packages/database/src/schema/`.
Every table has uuid PK (`defaultRandom`) and timestamptz timestamps unless
noted. Enum values come from `@keki/contracts` constants.

| Table | Columns (beyond id/timestamps) |
| --- | --- |
| `households` | name, primary_customer_id FK→customers (circular, emitted as post-hoc ALTER) |
| `customers` | household_id FK, cognito_sub (unique, Cognito join key), email citext unique, phone, first/last_name, role enum (default CUSTOMER), status |
| `children` | household_id FK, first/last_name, date_of_birth, notes |
| `offerings` | slug unique, name, description, type enum (CLASS/ROOM/OPEN_PLAY), duration_minutes, default_capacity, price_cents, currency char(3), status enum (DRAFT/PUBLISHED/ARCHIVED) |
| `occurrences` | offering_id FK, starts_at/ends_at timestamptz, capacity_override, status enum; indexes on starts_at and (offering_id, starts_at) |
| `reservations` | occurrence_id, household_id, created_by_customer_id FKs, status enum (HELD/CONFIRMED/CHECKED_IN/CANCELLED/NO_SHOW), seat_count, hold_expires_at, notes; index (occurrence_id, status); **capacity-enforced** by the `reservations_capacity_check` trigger (`0002_capacity_constraint.sql`) — `HELD`/`CONFIRMED`/`CHECKED_IN` consume a seat under a row lock on the occurrence, `CANCELLED`/`NO_SHOW` don't |
| `reservation_participants` | reservation_id FK (cascade), customer_id XOR child_id (CHECK constraint mirrors the contracts discriminated union), waiver_record_id FK, checked_in_at |
| `catalog_items` | square_catalog_object_id, square_variation_id unique, name, description, price_cents, currency char(3), status enum (ACTIVE/ARCHIVED), synced_at — cafe items kept warm from Square's Catalog API by `syncCatalog` |
| `orders` | household_id, created_by_customer_id FKs, status enum (DRAFT/AWAITING_PAYMENT/PAID/CANCELLED/EXPIRED), subtotal_cents, currency char(3), square_order_id unique, square_checkout_url, provider_payment_id, expires_at |
| `order_line_items` | order_id FK (cascade), kind enum (CATALOG_ITEM/OCCURRENCE), catalog_item_id XOR occurrence_id (CHECK), reservation_id, quantity (CHECK > 0), unit_price_cents (CHECK >= 0), name_snapshot |
| `play_passes` | household_id FK, offering_id FK, total/remaining_credits, purchased_at, expires_at, status |
| `play_pass_ledger` | **append-only** (DB trigger): play_pass_id FK, delta_credits, reason enum (PURCHASE/REDEMPTION/ADJUSTMENT/EXPIRY/REFUND), reservation_id, actor_customer_id, occurred_at, metadata jsonb; index (play_pass_id, occurred_at) |
| `payment_records` | household_id FK, reservation_id FK, provider (default SQUARE), provider_payment_id unique (webhook idempotency key), amount_cents, currency, status enum (PENDING/AUTHORIZED/CAPTURED/REFUNDED/FAILED), raw_payload jsonb, occurred_at |
| `notification_outbox` | channel enum (EMAIL/SMS/MARKETING), template_key, recipient_customer_id FK, recipient_address, payload jsonb, status enum (PENDING/CLAIMED/SENT/FAILED/DEAD), attempts, available_at, claimed_at/claimed_by (crash lease), sent_at, last_error; index (status, available_at) |
| `waiver_records` | provider, provider_reference unique (idempotency key), household_id FK, customer_id / child_id FKs, signed_at, expires_at, document_s3_key, status enum (SIGNED/EXPIRED/REVOKED) |
| `staff_audit_log` | actor_customer_id FK, action, entity_type, entity_id, before/after jsonb, occurred_at, ip_address inet — written by `@keki/catalog-admin`'s `recordAuditEntry`, in the same transaction as every offering/occurrence mutation (`phase-3-admin-catalog`; previously unwritten) |

Connections: application traffic uses the Neon **pooled** URL
(`NeonPooledUrl`); migrations use the **direct** URL (`NeonDirectUrl`). The
two are separate secrets and not interchangeable.

## API Endpoints

No separate REST API — Server Actions (`'use server'`) are the mutation
surface, one authorization boundary each (`authenticatedAction`, see the
`web (apps/web)` section above). Pages are gated by `middleware.ts` +
`app/auth/guards.ts`:

**Customer `(customer)`** (session required): `/account`, `/book`, `/cart`, `/checkout/mock/[orderId]`, `/orders/[orderId]`
**Kiosk `/kiosk`** (shared `KIOSK_DEVICE_TOKEN` device session): `/kiosk/book`, `/kiosk/waiver` (still placeholders)
**Staff `/staff`** (role ≥ FRONT_OF_HOUSE): `/staff/check-in`, `/staff/occupancy` (still fake data), `/staff/today`
**Admin `/admin`** (role ≥ MANAGER): `/admin/offerings`, `/admin/schedules`, `/admin/reservations` (real, `phase-3-admin-catalog`); `/admin/customers` (still placeholder)
**Auth**: `/auth/sign-in`, `/auth/complete-profile`, `/auth/unauthorized`
**Public**: `/` (root landing)

One HTTP ingress outside Next.js: the `square-webhook` Lambda Function URL —
now publicly reachable (`authType: "none"`), gated by Square's real
signature scheme rather than IAM (see `functions/*` above).

## Protocols / Events

All queue messages share a versioned envelope
(`{ version: 1, type, occurredAt, payload }`) with Zod schemas in
`@keki/contracts`:

- `notification.drain` → NotificationQueue → notification-worker
- `reconciliation.run` → ReconciliationQueue → reconciliation-worker
- scheduled-task messages (open `taskKey` string) → ScheduledTaskQueue → scheduled-task-worker
- Square webhook envelope (Square's real HMAC-SHA256 scheme, verified once at
  the Function URL before enqueueing) → SquareWebhookQueue → square-webhook consumer

Notification delivery uses the `notification_outbox` table as a transactional
outbox with a CLAIMED lease state; abandoned claims are reaped back to
PENDING and eventually dead-letter via `attempts`.

## Infrastructure

- **SST v3** (`sst.config.ts`, app name `keki`, region `us-west-2`;
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
- **Secrets** (`sst.Secret`, eleven total — see `docs/environment.md`):
  NeonPooledUrl, NeonDirectUrl, SquareAccessToken, SquareEnvironment,
  SquareWebhookSignatureKey, SquareNotificationUrl (configured, not derived —
  `infra/index.ts` asserts it matches the deployed Function URL),
  CartCookieSecret, AppBaseUrl, KlaviyoApiKey, WaiverProviderApiKey,
  KioskDeviceToken.
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

Resolved by `phase-2-square-ordering` and `phase-3-admin-catalog` (kept here
only so the "as of" history is legible, not as open items): reservation
capacity enforcement, real webhook signature verification, Server Actions
existing at all, and `staff_audit_log` having a writer.

Still open, per `docs/vision.md`'s "Scope: Phase 2+":

- **Play passes are still stubs** — `issuePass`, `redeemCredits`,
  `expirePass` all reject `NotImplementedInPhase1`; `play_pass_ledger`'s
  append-only guarantee is enforced but nothing writes to it yet.
- **Waiver signing is still a stub** — `startWaiverSigning`, and
  `customer-core`'s `addChild`/`updateHousehold`.
- **Payment capture/refund are still stubs** — `capturePayment`,
  `refundPayment` in `commerce-core`. Not on the checkout-link happy path;
  needed once refunds or manual capture are in scope.
- **reconciliation-worker is still a skeleton** — no comparison against
  Square or reservation state.
- **Kiosk auth is still a shared static device token**, and `/kiosk/book`,
  `/kiosk/waiver` are still placeholders.
- **Notification providers are still no-ops** (`createNoopProviders`) — no
  real SES/SMS/Klaviyo integration, and no caller yet enqueues an order or
  booking confirmation onto the outbox at all.
- **`/staff/occupancy` still renders fake data**.
- **`/admin/customers` is still a placeholder.**

## Programs Completed

1. `phase-1-scaffold` — structural skeleton: monorepo, 13-table Drizzle
   schema, Cognito/Postgres auth split, four route groups, SST-provisioned
   AWS resources, four SQS workers, Vitest + Playwright CI. Built 2026-08-04
   → 2026-08-06 (all 13 workstreams complete).
2. `phase-2-square-ordering` — the ordering domain end to end: `catalog-core`
   and `commerce-core` real query/command paths, `square-client` (real +
   stub), cart/checkout/orders customer surface, the `reservations` capacity
   trigger, the real Square webhook signature scheme with a now-public
   Function URL, and the `catalog_items`/`orders`/`order_line_items` tables
   (`0001_chief_gressill.sql`, `0002_capacity_constraint.sql`).
3. `phase-3-admin-catalog` — the admin catalog domain: `catalog-admin`
   (offering/occurrence commands, the DRAFT/PUBLISHED/ARCHIVED and
   scheduling state machines), `/admin/offerings`, `/admin/schedules`,
   `/admin/reservations`, the MANAGER Server Action boundary, and
   `staff_audit_log`'s first writer — every mutation audited in the same
   transaction as the change it describes (SC-11). Closed with
   `admin-catalog.spec.ts`, the Playwright journey proving a manager can
   create and publish a class that a customer can then find and book on
   `/book` (SC-16, SC-07). Built 2026-08-21 (all nine workstreams complete).
