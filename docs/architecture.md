# Architecture

A short orientation for a new contributor. For the product vision, the full
data model, and the reasoning behind each Phase 1 scope decision, see
[`docs/vision.md`](vision.md) — this page does not repeat that content.

## The package graph

```
apps/web (Next.js 15, Server Actions)  ─┐
functions/* (Lambda handlers)          ─┼─► packages/*-core, packages/contracts
                                         │   packages/auth, packages/database
                                         └─► packages/ui (apps/web only)
```

- `apps/web` and `functions/*` both import the domain packages **directly**,
  as plain TypeScript module imports — there is no internal HTTP hop between
  the app and the core for first-party traffic.
- `packages/*-core` (`reservation-core`, `customer-core`, `pass-core`,
  `commerce-core`, `notification-core`) are the domain libraries: booking,
  customer/household management, play-pass ledger, payments, and outbound
  messaging, respectively.
- `packages/contracts` holds types and schemas shared across package
  boundaries, so a type crossing a boundary is defined once, not duplicated
  at both ends.
- `packages/auth` and `packages/database` are infrastructure-facing
  libraries every domain package and both deployment surfaces depend on.
- `packages/ui` is consumed only by `apps/web`.

## Why the cores are plain libraries

`packages/*-core` have no framework dependency: no Next.js, no React, no AWS
SDK beyond what a given package genuinely needs. This is what lets the same
booking logic run inside a Next.js Server Action (synchronous, user-facing)
and inside a Lambda handler (asynchronous, triggered by SQS or EventBridge)
without a network call between them — the deployment boundary and the module
boundary are separate decisions, and the core doesn't need to know which
runtime it's in.

## Why there is no Lambda per package

`functions/` holds exactly four workers — `square-webhook`,
`notification-worker`, `reconciliation-worker`, `scheduled-task-worker` — not
one per domain package. Deployment boundaries are chosen per workload (what
needs to run asynchronously, and on what trigger), not per module. Adding a
new domain package should never imply adding a new Lambda; most domain logic
is reached synchronously from `apps/web`'s Server Actions instead.

## The Cognito/Postgres split

Identity and application data are deliberately owned by two different
systems:

- **Cognito** owns authentication: credentials, sign-in, and issuing the
  JWTs `packages/auth` verifies.
- **Postgres** owns application profiles and role assignment (`customers`,
  `households`, and the `role` column) — everything the app needs to know
  about a person beyond "who are they."

`packages/auth` bridges the two by resolving a Cognito subject
(`cognito_sub`) to a `customers` row. A Cognito group is never treated as the
authoritative role; Postgres is. This keeps credential storage out of the
application database entirely, and keeps role/profile changes (which happen
often, as staff are added or a customer's household changes) out of Cognito
(which changes rarely).

## Where to go deeper

- [`docs/vision.md`](vision.md) — product vision, full data model, Phase 1
  vs. Phase 2 scope.
- [`AGENTS.md`](../AGENTS.md) — the conventions this architecture is meant to
  enforce (module boundaries, data access rules, testing, delivery).
- [`docs/environment.md`](environment.md) — how each of these boundaries
  maps to environment variables and SST secrets.
