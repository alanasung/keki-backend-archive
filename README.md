# keki-backend-prod

Keki is the commerce and operations platform for a cafe that also runs
classes, rents rooms, and hosts open play sessions. It's a single Next.js 15
application on AWS serving four surfaces — customer, kiosk, staff, and admin
— backed by a set of plain TypeScript domain packages, Neon Postgres, and
Amazon Cognito. See [`docs/vision.md`](docs/vision.md) for the full product
vision and scope.

## Prerequisites

- **Node**, version pinned in [`.nvmrc`](.nvmrc) (currently `22`). With nvm:
  `nvm use`.
- **pnpm 9** (`packageManager` in `package.json` pins `9.15.9`). Install via
  [Corepack](https://pnpm.io/installation#using-corepack) or standalone.
- **An AWS account with credentials configured** (`aws configure`, or an
  equivalent credential provider) — required for `sst dev` / `sst deploy` and
  for setting SST secrets.
- **A Neon project** — provides the pooled and direct Postgres connection
  strings the app and its migrations use.

## Clone and install

```sh
git clone <this-repository-url>
cd keki-backend-prod
pnpm install
```

`pnpm install` also runs `postinstall` (`sst install`), which fetches SST's
provider plugins.

## Environment setup

Copy the example file and fill in real values:

```sh
cp .env.example .env
```

`.env.example` lists every environment variable this repository reads, each
with a comment on where to get a real value. See
[`docs/environment.md`](docs/environment.md) for the full reference table
(which surface consumes each variable, which are required, and how each one
is provisioned as an SST secret in a deployed stage).

`.env` isn't loaded automatically by every tool here — load it into your
shell before running commands that need it:

```sh
set -a && source .env && set +a
```

### Pooled vs. direct database URLs

Two of the variables are Neon connection strings, and they are **not
interchangeable**:

- `DATABASE_URL_POOLED` — the pooled endpoint (host contains `-pooler`),
  used by all application traffic.
- `DATABASE_URL_DIRECT` — the direct endpoint (host does not contain
  `-pooler`), used only by migrations.

If they're swapped, the application refuses to start with an error like:

```
DATABASE_URL_POOLED and DATABASE_URL_DIRECT appear to be swapped: DATABASE_URL_POOLED host "<host>" does not contain "-pooler". DATABASE_URL_POOLED must use the Neon pooled endpoint.
```

See [`docs/environment.md`](docs/environment.md#pooled-vs-direct) for the
full explanation and the reverse-case error message.

## Database

With `DATABASE_URL_DIRECT` set (see above), apply migrations:

```sh
pnpm db:migrate
```

This runs `drizzle-orm`'s migrator against the direct connection string,
applying everything in `packages/database/drizzle/`.

## Run locally

```sh
pnpm dev
```

Runs the Next.js dev server (`pnpm --filter web dev`). `apps/web/.env.development`
ships with syntactically-valid placeholder values for the required
variables, so `pnpm dev` boots and serves the placeholder routes even before
you've filled in real credentials — you'll need real ones (exported per
"Environment setup" above) for the app to actually reach Postgres or Cognito.

## Link to AWS

```sh
pnpm sst:dev
```

Runs `sst dev`, which provisions/links this stage's AWS resources (Cognito
User Pool, SQS queues, S3 bucket, secrets) and pushes their values into the
running app. Requires AWS credentials and the SST secrets for this stage to
already be set — see [`docs/environment.md`](docs/environment.md#provisioning-the-sst-secrets)
for the exact `pnpm sst secret set` commands.

## Run tests

```sh
pnpm test        # pnpm -r test — unit and integration tests (Vitest)
pnpm test:e2e     # end-to-end tests (Playwright)
```

See [`docs/testing.md`](docs/testing.md) for what each test layer covers,
which ones need a real Postgres connection, and how CI runs them.

## Repository layout

```
apps/web/                 Next.js 15 app — customer, kiosk, staff, admin route groups
functions/                Lambda handlers: square-webhook, notification-worker,
                           reconciliation-worker, scheduled-task-worker
packages/
  auth/                    Cognito verification, session resolution
  database/                Drizzle schema, migrations, connection env
  contracts/                Shared types and schemas
  ui/                       Shared React components (apps/web only)
  reservation-core/         Booking domain logic
  customer-core/            Customer/household domain logic
  pass-core/                 Play-pass ledger domain logic
  commerce-core/             Payment domain logic
  notification-core/         Outbound messaging domain logic
infra/                     SST infrastructure definitions
docs/                      Vision, testing, environment, architecture docs
scripts/                   One-off operational scripts (e.g. sample SQS message)
```

See [`docs/architecture.md`](docs/architecture.md) for why the packages are
organized this way.

## Where to go next

- [`AGENTS.md`](AGENTS.md) — the authoritative conventions document.
- [`docs/vision.md`](docs/vision.md) — product vision and scope.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — workflow and contribution
  conventions.

## Current state

This is a Phase 1 scaffold. Per [`docs/vision.md`](docs/vision.md#scope-phase-1)
§ Scope: Phase 1, the following are deliberately **not** built yet — routes
exist as placeholders, not broken features:

- No booking logic — reservation capacity and scheduling rules are not
  implemented.
- No Square checkout — payment processing is not wired up.
- No waiver signing — the waiver provider integration is a typed interface
  only, with no implementation.
- No Klaviyo flows — marketing/lifecycle messaging is not implemented.
- No-op notification providers — outside production, email/SMS/marketing
  sends are no-ops (`KEKI_ALLOW_NOOP_PROVIDERS`); no provider has a real
  implementation yet.
