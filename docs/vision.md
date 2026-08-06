# keki-backend-prod — Vision Document

## What Is keki-backend-prod?

Keki is the commerce and operations platform for a cafe that sells more than
food: it runs classes, rents rooms, and hosts open play sessions. The
application is a single Next.js 15 app on AWS that serves four distinct
surfaces — customer, kiosk, staff, and admin — backed by a set of plain
TypeScript domain packages. It owns booking, payment, waivers, passes, and
customer communication, integrating Square for payments, a waiver provider for
liability signing, and Klaviyo/SES/SMS for messaging.

**One-liner:** Next.js ecommerce and scheduling platform for a cafe: class and room booking, Square integration, and customer communication, deployed on AWS.

## The Problem

Running a cafe with scheduled programming means stitching together a booking
tool, a POS, a waiver service, and an email platform — none of which share a
customer record. Staff reconcile by hand, families re-enter the same
information at every touchpoint, and nobody has a single view of who is in the
building right now or what they have already paid for.

Keki collapses those systems into one: Square remains the payment processor and
the waiver provider remains the signing system of record, but the customer,
household, reservation, and pass state live in one Postgres database that every
surface reads from.

## The Solution

One Next.js application, four route groups, one domain core.

- **Server Actions** in the Next.js app import the domain packages directly —
  no internal API hop for first-party traffic.
- **Standalone Lambda handlers** import the same packages for asynchronous
  work: Square webhooks, notification delivery, reconciliation, and scheduled
  tasks.
- **Core packages are plain TypeScript libraries.** There is deliberately _not_
  a Lambda per package; the deployment boundary and the module boundary are
  separate decisions.

Authentication is split: Cognito owns identity and credentials, Postgres owns
application profiles and role assignments. Integrations are defined as typed
client interfaces so the domain never depends on a vendor SDK directly.

## Architecture

```
                    ┌────────────────────────────────────┐
                    │      apps/web (Next.js 15)         │
                    │                                    │
                    │  (customer)/   kiosk/              │
                    │    book/         book/             │
                    │    account/      waiver/           │
                    │                                    │
                    │  staff/        admin/              │
                    │    today/        offerings/        │
                    │    check-in/     schedules/        │
                    │    occupancy/    reservations/     │
                    │                  customers/        │
                    └──────────────┬─────────────────────┘
                                   │ Server Actions
                                   │ (direct import)
                    ┌──────────────▼─────────────────────┐
                    │        packages/ (domain core)     │
                    │  reservation-core   customer-core  │
                    │  pass-core          commerce-core  │
                    │  notification-core                 │
                    │  contracts   auth   database   ui  │
                    └──────┬───────────────────────┬─────┘
                           │                       │
              ┌────────────▼──────────┐   ┌────────▼─────────┐
              │  Neon Postgres        │   │  functions/      │
              │  (Drizzle ORM)        │   │  square-webhook  │
              │  pooled → app traffic │   │  notification-   │
              │  direct → migrations  │   │    worker        │
              └───────────────────────┘   │  reconciliation- │
                                          │    worker        │
              ┌───────────────────────┐   │  scheduled-task- │
              │  Cognito User Pool    │   │    worker        │
              │  (identity only)      │   └────────┬─────────┘
              └───────────────────────┘            │
                                          ┌────────▼─────────┐
                                          │ SQS + DLQ        │
                                          │ EventBridge Sched│
                                          │ S3 (documents)   │
                                          └──────────────────┘
```

Provisioned with SST + OpenNext. CloudWatch alarms watch queue failures.

## Core Concepts

| Concept                 | Meaning                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| **Household**           | The billing and grouping unit. Customers and children belong to a household.                            |
| **Customer**            | An adult account holder with a Cognito identity and a Postgres profile.                                 |
| **Child**               | A non-authenticating participant attached to a household; the subject of many reservations and waivers. |
| **Offering**            | A sellable, schedulable thing: a class, a room, an open-play session.                                   |
| **Occurrence**          | A specific dated instance of an offering — what a reservation actually points at.                       |
| **Reservation**         | A held or confirmed claim on an occurrence, with participants attached.                                 |
| **Play pass**           | Prepaid, drawn-down entitlement to play sessions, tracked by an append-only ledger.                     |
| **Waiver record**       | Proof that a liability waiver was signed for a participant, sourced from the waiver provider.           |
| **Notification outbox** | Durable queue of outbound customer messages, drained by the notification worker.                        |

## API Surface

There is no public REST API in Phase 1. The surfaces are:

- **Server Actions** — first-party mutations from the four route groups.
- **Lambda handlers** — `square-webhook` (inbound from Square),
  `notification-worker`, `reconciliation-worker`, `scheduled-task-worker` (all
  SQS/EventBridge triggered).
- **Typed integration clients** — `SquareClient`, `WaiverProvider`,
  `MarketingProvider`, `TransactionalEmailProvider`, `SmsProvider`. Interfaces
  are defined in Phase 1; production implementations are not.

## Data Model

Drizzle tables, scaffolded in Phase 1:

- **Identity & people** — `households`, `customers`, `children`
- **Catalog & scheduling** — `offerings`, `occurrences`
- **Booking** — `reservations`, `reservation_participants`
- **Entitlements** — `play_passes`, `play_pass_ledger`
- **Compliance** — `waiver_records`
- **Money** — `payment_records`
- **Messaging** — `notification_outbox`
- **Operations** — `staff_audit_log`

Reservation-capacity logic is deliberately not finalized in Phase 1.

## Target Users

| Persona                        | Surface       | Needs                                                                                           |
| ------------------------------ | ------------- | ----------------------------------------------------------------------------------------------- |
| **Customer** (parent/guardian) | `(customer)/` | Book classes and rooms, manage household and children, buy and spend play passes, sign waivers. |
| **Walk-in visitor**            | `kiosk/`      | Self-serve booking and waiver signing on-site, without an account-first flow.                   |
| **Front of house**             | `staff/`      | See today's schedule, check people in, know current occupancy.                                  |
| **Manager / Admin**            | `admin/`      | Define offerings, publish schedules, resolve reservations, look up customers.                   |

Roles: `CUSTOMER`, `FRONT_OF_HOUSE`, `MANAGER`, `ADMIN`.

## Scope: Phase 1

**Build — initial scaffold only:**

- Monorepo: `apps/web`, the nine `packages/*` libraries, the four `functions/*`
  handlers.
- Next.js app with placeholder pages for all four route groups and shared
  navigation.
- Drizzle schema and migrations for the thirteen tables above.
- SST resources: OpenNext deployment, SQS queues with DLQs, EventBridge
  Scheduler execution role, private S3 document bucket, Cognito User Pool,
  secrets for Neon/Square/Klaviyo/waiver credentials, CloudWatch queue alarms.
- Typed integration interfaces with no production implementation.
- Auth wiring: Cognito for identity, Postgres for profiles and role
  assignment; staff and admin routes gated.

**Success criteria:**

- `pnpm dev` runs the Next.js application.
- `sst dev` links the application to AWS resources.
- Neon migrations run successfully (direct connection string).
- Placeholder customer, kiosk, staff, and admin routes load.
- Staff/admin routes require authentication.
- Shared packages compile independently.
- Vitest and Playwright run in CI.
- A sample SQS message can be published and consumed.
- Environment setup is documented in the repository README.

**Do not build in Phase 1:**

- Booking capacity and reservation logic
- Square checkout
- Waiver signing
- Klaviyo flows
- Webflow content

## Scope: Phase 2+

The deferred Phase 1 items are the Phase 2 backlog: reservation capacity rules,
Square checkout and payment reconciliation, waiver signing end to end, play-pass
draw-down at check-in, and Klaviyo lifecycle flows. Architectural decisions in
Phase 1 should assume all of them are coming — in particular, that the
notification outbox will carry real volume, that `play_pass_ledger` must stay
append-only and auditable, and that Square is the source of truth for money
while Postgres is the source of truth for entitlement.

---

## Assumptions to confirm

These were inferred from the scaffold brief, not stated. Correct them here
before the first program is planned:

1. **The Problem / Target Users** sections are inferred from the four route
   groups and the schema. The personas are structurally implied, but their
   actual pain points are my guess.
2. **Play passes** are read as prepaid drawn-down entitlements because of the
   paired `play_passes` / `play_pass_ledger` tables. If they are instead
   memberships or unlimited passes, the ledger's meaning changes.
3. **Kiosk** is assumed to be shared on-site hardware with a non-account-first
   flow, which has real auth implications not yet specified.
4. **Square is the money source of truth, Postgres the entitlement source of
   truth** — stated as a Phase 2 architectural assumption, not from the brief.
