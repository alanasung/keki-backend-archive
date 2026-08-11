# Environment reference

This is the full reference for every environment variable and SST secret
this repository uses. See the root [`.env.example`](../.env.example) for a
copy-pasteable starting point, and [`README.md`](../README.md#environment-setup)
for the first-run setup path.

## Variables

Every variable is validated eagerly at module load (`packages/database/src/env.ts`,
`packages/auth/src/env.ts`) or at first use (`apps/web`, `functions/*`) — a
missing required variable fails loudly and names itself, rather than
producing an `undefined` that surfaces later as a confusing error.

### Linked into the web app (`apps/web`)

| Variable | Required | Consumed by | How to obtain |
| --- | --- | --- | --- |
| `DATABASE_URL_POOLED` | Yes | `packages/database/src/env.ts` | Neon project dashboard → Connection Details → "Pooled connection". Host must contain `-pooler`. |
| `DATABASE_URL_DIRECT` | Yes | `packages/database/src/env.ts` | Neon project dashboard → Connection Details → "Direct connection". Host must **not** contain `-pooler`. |
| `COGNITO_USER_POOL_ID` | Yes | `packages/auth/src/env.ts` | AWS Cognito console, or `sst dev`/`sst deploy` output once infra is provisioned. |
| `COGNITO_CLIENT_ID` | Yes | `packages/auth/src/env.ts` | AWS Cognito console (the App Client `apps/web` authenticates against), or SST output. |
| `AWS_REGION` | Yes | `packages/auth/src/env.ts` | The AWS region the Cognito User Pool lives in (`sst.config.ts` uses `us-west-2`). |
| `KIOSK_DEVICE_TOKEN` | No — kiosk routes redirect to sign-in without it, the app still boots | `apps/web/app/auth/guards.ts` (`requireKioskDevice`) | Any string locally; a deployed stage gets it from the `KioskDeviceToken` SST secret. |
| `CART_COOKIE_SECRET` | Yes | `apps/web/app/(customer)/cart/cart-cookie.ts` | Any string locally; a deployed stage gets it from the `CartCookieSecret` SST secret. |
| `APP_BASE_URL` | Yes, for WS-13's Square redirect URL | Server configuration, never a request header (WS-13) | A deployed stage gets it from the `AppBaseUrl` SST secret, set to that stage's public URL. |

### Linked into individual functions (`functions/*`), not the web app

| Variable | Required | Consumed by | How to obtain |
| --- | --- | --- | --- |
| `SQUARE_WEBHOOK_SIGNATURE_KEY` | Yes, for `functions/square-webhook` | `functions/square-webhook/src/http.ts` | Square Developer Dashboard → your application → Webhooks → Signature Key. A deployed stage gets it from the `SquareWebhookSignatureKey` SST secret. |
| `SQUARE_ACCESS_TOKEN` | Yes, for `functions/square-webhook` and `functions/scheduled-task-worker` | `packages/square-client/src/env.ts` | Square Developer Dashboard → your application → Credentials. A deployed stage gets it from the `SquareAccessToken` SST secret. |
| `SQUARE_ENVIRONMENT` | Yes, for `functions/square-webhook` and `functions/scheduled-task-worker` | `packages/square-client/src/env.ts` | `"sandbox"` or `"production"`. A deployed stage gets it from the `SquareEnvironment` SST secret; refuses `"sandbox"` when `NODE_ENV=production`. |
| `SQUARE_NOTIFICATION_URL` | Yes, for `functions/square-webhook` | `functions/square-webhook/src/http.ts` | The deployed `square-webhook` Function URL, registered in Square's dashboard. Configured (not derived) via the `SquareNotificationUrl` SST secret — `infra/index.ts` fails the deploy if it disagrees with the real Function URL, including by a trailing slash. |
| `KEKI_ALLOW_NOOP_PROVIDERS` | No | `packages/notification-core/src/providers.ts`, consumed by `functions/notification-worker` | Not a credential — a feature flag. `infra/queues.ts` sets it to `"true"` automatically on every non-production stage; refused outside that. |

### Test-only overrides (rejected in production)

| Variable | Required | Consumed by | How to obtain |
| --- | --- | --- | --- |
| `COGNITO_ISSUER` | No | `packages/auth/src/env.ts` | Set only by the Playwright e2e suite, to the local JWKS server's URL (`docs/testing.md`). |
| `COGNITO_JWKS_URI` | No | `packages/auth/src/env.ts` | Same as above — the local JWKS server's well-known endpoint. |

`packages/auth/src/env.ts` throws `AuthConfigError` at import time if either
override is present while `NODE_ENV=production`: an issuer override in
production is an authentication bypass, since anyone who can set the
variable can mint tokens accepted as genuine.

## Pooled vs. direct

`DATABASE_URL_POOLED` and `DATABASE_URL_DIRECT` point at two different Neon
endpoints and are **not interchangeable**:

- `DATABASE_URL_POOLED` — the pooled endpoint (host contains `-pooler`).
  Used by all application traffic: the Next.js app and every Lambda worker.
- `DATABASE_URL_DIRECT` — the direct endpoint (host does not contain
  `-pooler`). Used only by `pnpm db:migrate` / drizzle-kit, since DDL run
  through the connection pooler fails in confusing ways.

If the two are swapped, `packages/database/src/env.ts`'s startup guard
refuses to let the process continue, with one of these two error messages:

```
DATABASE_URL_POOLED and DATABASE_URL_DIRECT appear to be swapped: DATABASE_URL_POOLED host "<host>" does not contain "-pooler". DATABASE_URL_POOLED must use the Neon pooled endpoint.
```

```
DATABASE_URL_POOLED and DATABASE_URL_DIRECT appear to be swapped: DATABASE_URL_DIRECT host "<host>" contains "-pooler". DATABASE_URL_DIRECT must use the Neon direct endpoint.
```

If you land here from a search, double-check which of the two Neon
connection strings you assigned to which variable.

## Provisioning the SST secrets

`infra/secrets.ts` declares eleven `sst.Secret`s. Every one of them must be
set per stage before `sst dev` or `sst deploy` can link it — an unset secret
fails the run, not silently falls back to a default. Set each with:

```sh
pnpm sst secret set <Name> <value> --stage <stage>
```

The eleven secrets:

| Secret | Set with |
| --- | --- |
| `NeonPooledUrl` | `pnpm sst secret set NeonPooledUrl "postgresql://...-pooler.../keki?sslmode=require" --stage <stage>` |
| `NeonDirectUrl` | `pnpm sst secret set NeonDirectUrl "postgresql://.../keki?sslmode=require" --stage <stage>` |
| `SquareAccessToken` | `pnpm sst secret set SquareAccessToken "<square-access-token>" --stage <stage>` |
| `SquareEnvironment` | `pnpm sst secret set SquareEnvironment "sandbox" --stage <stage>` (or `"production"`) |
| `SquareWebhookSignatureKey` | `pnpm sst secret set SquareWebhookSignatureKey "<square-webhook-signature-key>" --stage <stage>` |
| `SquareNotificationUrl` | `pnpm sst secret set SquareNotificationUrl "<square-webhook Function URL>" --stage <stage>` — set **after** the first deploy of a stage, from that deploy's `squareWebhookUrl` output, character for character. |
| `CartCookieSecret` | `pnpm sst secret set CartCookieSecret "<any-random-string>" --stage <stage>` |
| `AppBaseUrl` | `pnpm sst secret set AppBaseUrl "https://<stage-public-url>" --stage <stage>` |
| `KlaviyoApiKey` | `pnpm sst secret set KlaviyoApiKey "<klaviyo-api-key>" --stage <stage>` |
| `WaiverProviderApiKey` | `pnpm sst secret set WaiverProviderApiKey "<waiver-provider-api-key>" --stage <stage>` |
| `KioskDeviceToken` | `pnpm sst secret set KioskDeviceToken "<any-random-string>" --stage <stage>` |

`NeonPooledUrl`, `NeonDirectUrl`, `KioskDeviceToken`, `CartCookieSecret`, and
`AppBaseUrl` are linked into the web app (`infra/web.ts`'s `WEB_ENV_MAPPING`);
`SquareWebhookSignatureKey`, `SquareAccessToken`, `SquareEnvironment`, and
`SquareNotificationUrl` are linked into `functions/square-webhook`
(`infra/queues.ts`). `KlaviyoApiKey` and `WaiverProviderApiKey` are declared
for the Phase 2 integrations described in [`docs/vision.md`](vision.md) and
are not yet consumed by any package.

`SquareNotificationUrl` is configured, not derived: `infra/queues.ts` cannot
read the webhook Function URL back into that same function's own
environment (the URL is an output *of* the function). `infra/index.ts`
asserts agreement between the secret and the real Function URL on every
deploy and fails the deploy on any mismatch, including a trailing-slash
difference — a mismatch there rejects every genuine Square delivery and is
indistinguishable from an attack.

## Stage conventions

- **`dev` personal stages** — each engineer deploys to their own stage
  (`sst dev` defaults to a stage named after your local username). Freely
  disposable; `sst.config.ts` sets `removal: "remove"` and no deploy
  protection for any stage other than `production`.
- **`production`** — `sst.config.ts` sets `removal: "retain"` and
  `protect: true` for the `production` stage: resources are never torn down
  as a side effect, and `sst remove` refuses to run against it without
  explicit confirmation.

## Deploying to production

Production deploys are git-tracked and run **only from GitHub Actions**
(`.github/workflows/deploy.yml`): push a `v*` tag at a commit that passed CI
on main, then approve the run in the `production` GitHub Environment. The
workflow verifies CI passed for the tagged commit, runs migrations against
production Neon, deploys via OIDC-assumed credentials (no long-lived keys),
and finishes with an SQS round-trip smoke test.

A guard in `sst.config.ts` refuses `sst deploy --stage production` (and any
other program-evaluating command against that stage) outside GitHub Actions.
Setting SST secrets for production from a workstation still works — the
guard only covers operations that evaluate the infrastructure program.

Break-glass, for deploying a known-good tag while Actions is unavailable:

```sh
KEKI_ALLOW_LOCAL_PROD_DEPLOY=1 pnpm exec sst deploy --stage production
```

One-time setup for the pipeline (OIDC role, GitHub Environment, secrets) is
documented in [`docs/aws-iam-request.md`](aws-iam-request.md) under "GitHub
OIDC deploy role".
