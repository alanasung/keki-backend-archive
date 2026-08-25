# keki-backend-prod — As-Built System Snapshot

<!-- Last updated: 2026-08-24 after program: phase-5-customer-onboarding -->

Four domains are now real end to end: **ordering** (`phase-2-square-ordering`)
— browse the cafe menu and classes, cart, Square checkout, webhook-recorded
payment, order history —, **admin catalog management**
(`phase-3-admin-catalog`) — managers create, publish, and schedule classes
through `/admin`, with every mutation audited in `staff_audit_log` —,
**front-of-house staff surfaces** (`phase-4-staff-surfaces`) — staff see
today's schedule, check participants in and out of arrived state per
participant, and see who is currently in the building on `/staff` —, and
**customer onboarding** (`phase-5-customer-onboarding`) — a real Cognito
OAuth handshake with PKCE, first-time profile provisioning, a household that
can add a child and rename itself on `/account`, and a read-only staff lookup
of any household on `/admin/customers`. Not every domain command is a stub
anymore; see Known Limitations for what still is (play passes, waivers,
payment capture/refund, kiosk, notification delivery).

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
(`OFFERING_TRANSITIONS`, `ORDER_TRANSITIONS`, `RESERVATION_TRANSITIONS` +
`canTransitionReservation()`, `phase-4-staff-surfaces`) and `AUDIT_ACTIONS`
(`phase-3-admin-catalog`, gains staff check-in/no-show members in
`phase-4-staff-surfaces`); `hasAtLeastRole()` role-rank predicate;
`CAFE_TIME_ZONE` (moved here from `apps/web` in `phase-4-staff-surfaces` so a
domain package can compute today's boundaries); Zod schemas
(`createReservationSchema`, `registerCustomerSchema`, `cartSchema`,
`createOfferingSchema`, `scheduleOccurrenceSchema`, `checkInParticipantSchema`,
`undoCheckInParticipantSchema`, `markNoShowSchema`, …); the five integration
interfaces (`SquareClient`, `WaiverProvider`, `MarketingProvider`,
`TransactionalEmailProvider`, `SmsProvider`); versioned queue-message
envelopes + schemas (`NotificationMessage`, `ReconciliationMessage`,
scheduled-task and Square webhook messages); `NotImplementedInPhase1` error.

### @keki/database (packages/database)

Key exports: `db`, `schema`, `withTransaction` (Drizzle client over
`@neondatabase/serverless`); `recordAuditEntry` and `changedFields` (moved
here from `@keki/catalog-admin` in `phase-4-staff-surfaces` — a single-table
insert taking a transaction handle belongs with `withTransaction`, and both
`catalog-admin` and the new `staff-ops` depend on `database` already;
`catalog-admin` re-exports it so no caller broke). `src/env.ts` validates the
pooled/direct connection split eagerly at module load; `src/migrate.ts` runs
migrations over the direct URL (`db:migrate`). Schema lives in `src/schema/*`
(see Data Model). Three migrations: `0000_even_blob.sql` (the `citext`
extension and the `play_pass_ledger` append-only BEFORE UPDATE/DELETE
trigger, both hand-written), `0001_chief_gressill.sql`
(`phase-2-square-ordering`'s `catalog_items`, `orders`, `order_line_items`
tables), and `0002_capacity_constraint.sql` (hand-written: the
`reservations_capacity_check` BEFORE INSERT/UPDATE trigger — locks the
occurrence row with `FOR UPDATE`, sums active (`HELD`/`CONFIRMED`/`CHECKED_IN`)
seats, and raises SQLSTATE `KEKI1` over capacity, so concurrent bookings for
the same occurrence serialize instead of racing).

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
admin-side views, including live `bookedSeats`); every command above calls
`recordAuditEntry` in the **same transaction** as its own mutation
(`withTransaction`), so a rolled-back mutation leaves no `staff_audit_log`
row either — `recordAuditEntry` itself now lives in `@keki/database` (moved
in `phase-4-staff-surfaces`; re-exported here so no caller broke).
`generateUniqueSlug`/`slugify` for offering slugs.

### @keki/staff-ops (packages/staff-ops)

`phase-4-staff-surfaces`. Depends on contracts + database only — never on
`reservation-core` or `catalog-admin`, and never imported by the customer
surface (`apps/web/app/(customer)/`), both enforced by its own
`package-boundaries.test.ts`. Key exports: `checkInParticipant`,
`undoCheckInParticipant` (per-participant, writing
`reservation_participants.checked_in_at`; roll the owning reservation's
status between `CONFIRMED` and `CHECKED_IN` via `RESERVATION_TRANSITIONS`,
idempotent — a repeat writes no second `staff_audit_log` row),
`markReservationNoShow` (reservation-level; releases the seat, since
`NO_SHOW` is not seat-consuming under the capacity trigger); `cafeDayBounds`
(resolves "today" in `CAFE_TIME_ZONE` to UTC instants); `listTodaysOccurrences`,
`listOccurrenceRoster`, `getCurrentOccupancy` (the three staff read paths —
expected-vs-arrived counts, a roster by participant name, and a live
in-progress headcount). Every mutation records a `staff_audit_log` entry in
its own transaction, the same guarantee `catalog-admin` established.

### @keki/auth (packages/auth)

Key exports: `verifyToken` (Cognito JWT), `resolveSession`, `authorize`
(the single authorization predicate), `findProfileByCognitoSub`,
`extractToken` / `ID_TOKEN_COOKIE_NAME`, typed errors (`AuthConfigError`,
`InvalidTokenError`, `ProfileNotFoundError`). Cognito owns identity; the
`customers` row (keyed by `cognito_sub`) owns profile and role.
`COGNITO_ISSUER`/`COGNITO_JWKS_URI` test overrides are refused when
`NODE_ENV === 'production'`. `phase-5-customer-onboarding` adds the real
OAuth handshake: `createPkcePair`/`buildAuthorizationUrl` (the
authorization-code + PKCE request), `exchangeCodeForTokens`, `refreshSession`
/ `shouldRefresh` (near-expiry refresh, used by `middleware.ts`),
`buildSignOutUrl`, `cognitoOAuthEnv` (eagerly-validated
`COGNITO_HOSTED_UI_URL`/`COGNITO_REDIRECT_URI`/`COGNITO_SIGN_OUT_URI`,
`https`-only in production), and typed errors `OAuthExchangeError`,
`OAuthRefreshError`, `OAuthStateMismatchError`.

### Domain cores (all depend on contracts + database only)

- **@keki/reservation-core** — queries plus `holdReservation`,
  `confirmReservation`, `cancelReservation` (real as of
  `phase-2-square-ordering` — the capacity trigger above is what makes
  `holdReservation` safe under concurrency; a `capacity_exceeded` Postgres
  error surfaces as a typed domain error).
- **@keki/customer-core** — `getCustomerById`, `getHouseholdById`,
  `getHouseholdName`, `listHouseholdMembers`, `provisionCustomerProfile`
  (idempotent on `cognito_sub`), `searchCustomers` (real); `addChild`,
  `updateHousehold` (real as of `phase-5-customer-onboarding` — this
  program's first real `customer-core` write paths since Phase 1);
  `startWaiverSigning` (still a Phase-1 stub — waiver signing is Phase 2+ per
  `docs/vision.md`).
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
Zod parse, typed `ActionResult`), consumed by the customer cart/checkout
actions, by `app/admin/actions/*` (the MANAGER boundary
`phase-3-admin-catalog` built on top of it), and by `app/staff/actions/*`
(the FRONT_OF_HOUSE boundary `phase-4-staff-surfaces` built on top of it).
`apps/web/app/server-clients.ts` is the sole composition root for
`@keki/square-client`, honoring `KEKI_ALLOW_SQUARE_STUB` outside production
only.

`phase-5-customer-onboarding` adds the real OAuth handshake in place of the
Phase 1 placeholder: `/auth/sign-in` (a Route Handler, not a page — a Server
Component cannot set cookies during render — that sets the `state`/
`verifier`/`next` handshake cookies and redirects to Cognito's hosted UI with
PKCE), `/auth/callback` (validates `state` in constant time, exchanges the
code for tokens, and redirects to the originally-requested page or `/book`),
`/auth/sign-out` and `/auth/sign-out/complete` (clear the session and land on
Cognito's own sign-out redirect), and `/auth/complete-profile` (the one
mutation that must run before a profile exists — provisions a household and
customer for an `unprovisioned` session via `provisionCustomerProfile`,
idempotent on `cognito_sub`). Four cookies carry the session, their
attributes centralized in one place (`apps/web/app/auth/session-cookies.ts`)
rather than scattered across each route: `keki_id_token` (the one
`@keki/auth`'s `ID_TOKEN_COOKIE_NAME` names, read by every guard),
`keki_refresh_token`, and the short-lived `keki_oauth_state` /
`keki_oauth_verifier` handshake pair (plus `keki_oauth_next`, round-tripping
the originally-requested page through the redirect on the same lifetime).
`middleware.ts` refreshes a near-expired id token on any matched request
using the refresh token — a narrow exception to its "stamp `x-pathname`,
fast-path an anonymous redirect" job, not a foothold for real authorization,
which still lives entirely in `guards.ts`'s Node-runtime `requireRole`.

Customer surface is no longer placeholder-only: `/book` (cafe items +
bookable classes, live seat counts — and, since `phase-5-customer-onboarding`,
a participant picker that offers a newly added child immediately), `/cart`
(cookie-backed, HMAC-signed), `/checkout/mock/[orderId]` (a local stand-in
for Square's hosted checkout page in dev), `/orders/[orderId]`, and
`/account` (`phase-5-customer-onboarding`: household members and order
history, adding a child, and renaming the household — editing or removing an
existing member, buying/spending a play pass, and signing a waiver remain
unbuilt, and the page says so directly rather than rendering dead controls).
Admin surface: `/admin/offerings` (create/edit/publish/archive),
`/admin/schedules` (schedule/edit-capacity/cancel occurrences),
`/admin/reservations` (per-occurrence roster) — all `phase-3-admin-catalog`
— and `/admin/customers` (`phase-5-customer-onboarding`: a read-only staff
lookup by customer email or name, showing a household's members, children,
and recent orders — no mutation control of any kind). Staff surface
(`phase-4-staff-surfaces`, all reading `@keki/staff-ops`): `/staff/today`
(today's occurrences with expected-vs-arrived counts, in the cafe's
timezone), `/staff/check-in` (per-occurrence roster with check-in/undo/
no-show controls), `/staff/occupancy` (live in-progress headcount, dynamic
and never cached).

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
| `reservation_participants` | reservation_id FK (cascade), customer_id XOR child_id (CHECK constraint mirrors the contracts discriminated union), waiver_record_id FK, checked_in_at — now actually written, by `@keki/staff-ops`'s `checkInParticipant`/`undoCheckInParticipant` (`phase-4-staff-surfaces`; the column existed since Phase 1 but no code could reach it) |
| `catalog_items` | square_catalog_object_id, square_variation_id unique, name, description, price_cents, currency char(3), status enum (ACTIVE/ARCHIVED), synced_at — cafe items kept warm from Square's Catalog API by `syncCatalog` |
| `orders` | household_id, created_by_customer_id FKs, status enum (DRAFT/AWAITING_PAYMENT/PAID/CANCELLED/EXPIRED), subtotal_cents, currency char(3), square_order_id unique, square_checkout_url, provider_payment_id, expires_at |
| `order_line_items` | order_id FK (cascade), kind enum (CATALOG_ITEM/OCCURRENCE), catalog_item_id XOR occurrence_id (CHECK), reservation_id, quantity (CHECK > 0), unit_price_cents (CHECK >= 0), name_snapshot |
| `play_passes` | household_id FK, offering_id FK, total/remaining_credits, purchased_at, expires_at, status |
| `play_pass_ledger` | **append-only** (DB trigger): play_pass_id FK, delta_credits, reason enum (PURCHASE/REDEMPTION/ADJUSTMENT/EXPIRY/REFUND), reservation_id, actor_customer_id, occurred_at, metadata jsonb; index (play_pass_id, occurred_at) |
| `payment_records` | household_id FK, reservation_id FK, provider (default SQUARE), provider_payment_id unique (webhook idempotency key), amount_cents, currency, status enum (PENDING/AUTHORIZED/CAPTURED/REFUNDED/FAILED), raw_payload jsonb, occurred_at |
| `notification_outbox` | channel enum (EMAIL/SMS/MARKETING), template_key, recipient_customer_id FK, recipient_address, payload jsonb, status enum (PENDING/CLAIMED/SENT/FAILED/DEAD), attempts, available_at, claimed_at/claimed_by (crash lease), sent_at, last_error; index (status, available_at) |
| `waiver_records` | provider, provider_reference unique (idempotency key), household_id FK, customer_id / child_id FKs, signed_at, expires_at, document_s3_key, status enum (SIGNED/EXPIRED/REVOKED) |
| `staff_audit_log` | actor_customer_id FK, action, entity_type, entity_id, before/after jsonb, occurred_at, ip_address inet — written by `recordAuditEntry` (moved to `@keki/database` in `phase-4-staff-surfaces`; still called in the same transaction as every mutation, now including `@keki/staff-ops`'s check-in/undo/no-show commands alongside `catalog-admin`'s offering/occurrence commands) |

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
**Staff `/staff`** (role ≥ FRONT_OF_HOUSE): `/staff/today`, `/staff/check-in`, `/staff/occupancy` (real, `phase-4-staff-surfaces`)
**Admin `/admin`** (role ≥ MANAGER): `/admin/offerings`, `/admin/schedules`, `/admin/reservations` (real, `phase-3-admin-catalog`); `/admin/customers` (real, `phase-5-customer-onboarding`)
**Auth**: `/auth/sign-in` (Route Handler, redirects to Cognito's hosted UI), `/auth/callback`, `/auth/sign-out`, `/auth/sign-out/complete`, `/auth/complete-profile`, `/auth/unauthorized`
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

Resolved by `phase-2-square-ordering`, `phase-3-admin-catalog`,
`phase-4-staff-surfaces`, and `phase-5-customer-onboarding` (kept here only
so the "as of" history is legible, not as open items): reservation capacity
enforcement, real webhook signature verification, Server Actions existing at
all, `staff_audit_log` having a writer, the staff surfaces (`/staff/today`,
`/staff/check-in`, `/staff/occupancy`) no longer being placeholders, the
placeholder `/auth/sign-in` page replaced by a real Cognito OAuth handshake,
`customer-core`'s `addChild`/`updateHousehold` no longer being stubs, and
`/account`/`/admin/customers` no longer being placeholders.

Still open, per `docs/vision.md`'s "Scope: Phase 2+":

- **Play passes are still stubs** — `issuePass`, `redeemCredits`,
  `expirePass` all reject `NotImplementedInPhase1`; `play_pass_ledger`'s
  append-only guarantee is enforced but nothing writes to it yet.
- **Waiver signing is still a stub** — `startWaiverSigning`.
- **No social login or MFA** — the OAuth handshake drives only the standard
  authorization-code + PKCE flow against Cognito's hosted UI; adding another
  identity provider or multi-factor is a Cognito console/infra
  configuration decision, not something this program's code gates on.
- **No editing or deleting a child, and no staff editing a household** —
  `/account` can add a child and rename a household but not edit or remove
  an existing member; `/admin/customers` is read-only, by design (see
  `page.test.tsx`'s "renders no mutation control of any kind").
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
- **No check-out on the staff surface** — `reservation_participants` has no
  `checked_out_at` column; `/staff/occupancy` counts everyone checked in to
  an occurrence that has not yet ended, so someone who leaves early still
  counts until their class ends.
- **No walk-ups from the staff surface** — creating a reservation there would
  mean a booking-and-payment flow, which is deliberately out of scope; a
  walk-up still has to be booked through the customer or admin surface first.
- **No correction path for a mistaken `NO_SHOW`** — `RESERVATION_TRANSITIONS`
  has no transition out of `NO_SHOW` back to `CONFIRMED`, so marking the
  wrong reservation as a no-show cannot be undone from the staff surface
  today.

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
4. `phase-4-staff-surfaces` — the front-of-house staff domain: `staff-ops`
   (per-participant check-in/undo/no-show commands and today/roster/occupancy
   queries), `RESERVATION_TRANSITIONS` governing the reservation state
   machine, `recordAuditEntry`'s move from `catalog-admin` to `database`,
   `CAFE_TIME_ZONE`'s move from `apps/web` to `contracts`, `/staff/today`,
   `/staff/check-in`, `/staff/occupancy`, and the FRONT_OF_HOUSE Server Action
   boundary. Closed with `staff-check-in.spec.ts`, the Playwright journey
   proving a check-in on `/staff/check-in` is what `/staff/occupancy` counts
   (SC-17). Built 2026-08-22 → 2026-08-23 (all nine workstreams complete).
5. `phase-5-customer-onboarding` — the real Cognito OAuth handshake end to
   end: `@keki/auth`'s authorization-code + PKCE flow (`/auth/sign-in`,
   `/auth/callback`, `/auth/sign-out(/complete)`), the four session cookies
   centralized in `session-cookies.ts`, first-time profile provisioning
   (`/auth/complete-profile`, idempotent on `cognito_sub`), `customer-core`'s
   first real write paths since Phase 1 (`addChild`, `updateHousehold`), the
   editable `/account`, and the read-only staff lookup `/admin/customers`.
   Closed with `customer-onboarding.spec.ts`, the Playwright journey proving
   an unprovisioned account can complete a profile, add a child, and book
   that child into a class — with the newly added child selectable in the
   booking participant picker (SC-18, SC-15) — plus SC-10's idempotence and
   SC-17's proof that the existing session-cookie contract did not move.
   Built 2026-08-23 → 2026-08-24 (all nine workstreams complete).
