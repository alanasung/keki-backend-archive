# WS-10: SST infrastructure and AWS resources

## Goal

Define the SST v3 application: OpenNext deployment of `apps/web`, four SQS
queues each with a dead-letter queue, an EventBridge Scheduler execution role, a
private S3 document bucket, the Cognito User Pool, secrets for Neon, Square,
Klaviyo, and the waiver provider, and CloudWatch alarms on queue failure.

Every AWS resource is created here. Per `AGENTS.md`, nothing is created by hand
in the console.

This workstream is on the program's critical path and is the one most likely to
overrun. Do the account and credential prerequisites first.

## Traceability

- **SC-02** — `sst dev` links the application to its AWS resources.
- **SC-13** — Pooled and direct connection strings are configured as separate secrets.
- **SC-14** — Every SQS queue has a DLQ and a CloudWatch failure alarm.
- **SC-12** — Provisions the Cognito User Pool that holds identity.

## Dependencies

- **WS-03** — Database (the `DATABASE_URL_POOLED`/`DATABASE_URL_DIRECT` contract and its swap guard, which resource linking must satisfy).
- **WS-04** — Auth (the Cognito variable contract this workstream links).
- **WS-08** — App shell (OpenNext needs a real Next application to deploy).
- **WS-09** — Route protection (defines the `KIOSK_DEVICE_TOKEN` contract this workstream must link).

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Delivery" convention: SST owns all provisioning; every queue has a DLQ and an alarm
- `docs/vision.md` — "Architecture" (the AWS topology) and "Scope: Phase 1" (the resource list)
- `apps/web/next.config.ts` — the app being deployed
- `packages/database/src/env.ts` — the two connection-string variables that must be linked
- `packages/auth/src/env.ts` — `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, `AWS_REGION`

## Package

Repository root (`.`), with linked configuration reaching `apps/web`.

## Files Touched

- `sst.config.ts` (NEW) — SST app definition and stage config
- `infra/index.ts` (NEW) — resource composition entry
- `infra/secrets.ts` (NEW) — all `sst.Secret` declarations
- `infra/storage.ts` (NEW) — S3 document bucket
- `infra/auth.ts` (NEW) — Cognito User Pool and client
- `infra/queues.ts` (NEW) — four queues, four DLQs, redrive policies
- `infra/alarms.ts` (NEW) — CloudWatch alarms on the DLQs
- `infra/scheduler.ts` (NEW) — EventBridge Scheduler execution role
- `infra/web.ts` (NEW) — OpenNext Next.js deployment and resource linking
- `package.json` (MODIFY) — add `sst` dev dependency and `deploy`/`sst:dev` scripts
- `.gitignore` (MODIFY) — confirm `.sst/` and `.open-next/` are ignored
- `infra/queues.test.ts` (NEW)
- `infra/secrets.test.ts` (NEW)

## Existing Interfaces to Consume

The environment variables the application packages require. SST resource linking
must supply every one of these, or the app fails at module load — WS-03 and
WS-04 both validate their configuration eagerly:

```ts
// packages/database/src/env.ts (WS-03) — both required, never interchangeable
DATABASE_URL_POOLED; // Neon pooled endpoint; host contains "-pooler"
DATABASE_URL_DIRECT; // Neon direct endpoint; used only by migrations

// packages/auth/src/env.ts (WS-04)
COGNITO_USER_POOL_ID;
COGNITO_CLIENT_ID;
AWS_REGION;

// apps/web (WS-09)
KIOSK_DEVICE_TOKEN;

// functions/square-webhook (WS-11) — function environment, not the web app
SQUARE_WEBHOOK_SIGNATURE_KEY; // from the SquareWebhookSignatureKey secret

// functions/notification-worker (WS-11) — non-production stages only
KEKI_ALLOW_NOOP_PROVIDERS;
```

Six variables reach `apps/web`: the two database URLs, the three Cognito/region
values, and `KIOSK_DEVICE_TOKEN`. The last two are **function** environment
variables and must not be linked into the web app.

WS-03 additionally asserts that the pooled URL host contains `-pooler` and the
direct one does not, and throws if they are swapped. Set the two secrets
accordingly.

## Implementation Steps

1. **Do the prerequisites first.** Confirm AWS credentials, target account, and
   region before writing configuration. The program plan flags this workstream
   as the critical-path risk; discovering a missing account or an unbootstrapped
   region after writing all the infra code is the expensive failure mode.

2. **Create `sst.config.ts`.** Declare the app name `keki`, `home: 'aws'`, and
   the region. Set removal policy by stage: `retain` for `production`,
   `remove` otherwise. Set `protect: true` for the production stage so a
   stray `sst remove` cannot delete it.

3. **Declare secrets** in `infra/secrets.ts` as `sst.Secret` — never as literals
   in code, and never committed:

   - `NeonPooledUrl`, `NeonDirectUrl`
   - `SquareAccessToken`, `SquareWebhookSignatureKey`
   - `KlaviyoApiKey`
   - `WaiverProviderApiKey`
   - `KioskDeviceToken`

   Export them as one object so `infra/web.ts` and `infra/queues.ts` link the
   same instances rather than redeclaring them.

4. **Create the S3 document bucket** in `infra/storage.ts`. It holds signed
   waiver PDFs, so: **private access only**, `blockPublicAcls` and the rest of
   the public-access block enabled, versioning on, and default encryption
   enabled. Add a lifecycle rule transitioning noncurrent versions to cheaper
   storage.

   This bucket will contain documents identifying children. Do not attach a
   public read policy, a website configuration, or a permissive CORS rule.
   Phase 2 serves these through presigned URLs.

5. **Create the Cognito User Pool** in `infra/auth.ts`. Configure email as the
   sign-in alias, a password policy, and a user-pool client whose ID is exported
   for linking. Enable the hosted UI domain WS-09's sign-in placeholder will
   eventually use.

   **Do not create Cognito groups for the four roles.** `AGENTS.md` and WS-04
   both state Postgres is the role authority; creating groups invites someone to
   read them as authoritative later.

6. **Create the queues** in `infra/queues.ts`. Four queues, each with its own
   DLQ:

   | Queue                 | Purpose                                |
   | --------------------- | -------------------------------------- |
   | `SquareWebhookQueue`  | Buffers inbound Square webhook events  |
   | `NotificationQueue`   | Drives the notification outbox worker  |
   | `ReconciliationQueue` | Payment and reservation reconciliation |
   | `ScheduledTaskQueue`  | EventBridge Scheduler target           |

   For each, set a redrive policy with `maxReceiveCount: 5`, a visibility
   timeout at least six times the consuming function's timeout (the AWS-
   recommended ratio; a shorter one causes duplicate deliveries while a handler
   is still running), and a message retention period of 14 days on the DLQ so
   failures survive a weekend.

   Export queues and DLQs as a single map. WS-11 subscribes the handlers; this
   workstream only creates the queues and does not attach consumers.

   `SquareWebhookQueue` needs an HTTP producer, since Square delivers over HTTP
   and SQS has no public ingress. That producer is a **Function URL** on the
   `square-webhook` package's `httpHandler` entry point — but **WS-11 creates
   both the package and the Function URL**, not this workstream.

   The ownership split matters: WS-11 already depends on WS-10, so provisioning
   a Function URL here for a handler that does not exist yet would require WS-10
   to depend on WS-11 and create a dependency cycle. WS-10 owns the queues,
   DLQs, alarms, and secrets; WS-11 owns everything that attaches a handler to
   them.

   Export `SquareWebhookQueue` and the `SquareWebhookSignatureKey` secret so
   WS-11 can wire both.

7. **Create alarms** in `infra/alarms.ts`. For each of the four DLQs, a
   CloudWatch alarm on `ApproximateNumberOfMessagesVisible >= 1` over one
   period, with `treatMissingData: 'notBreaching'`. Also alarm on each main
   queue's `ApproximateAgeOfOldestMessage` exceeding a threshold, which catches
   a stalled consumer that is not yet dead-lettering.

   `treatMissingData: 'notBreaching'` matters: SQS publishes no data points for
   an empty queue, and the default treatment would leave every alarm
   permanently in `INSUFFICIENT_DATA`, which reads as broken monitoring.

   Wire alarms to an SNS topic. Subscribing a real endpoint is Phase 2; create
   the topic so the alarms have a target.

8. **Create the EventBridge Scheduler execution role** in `infra/scheduler.ts`:
   a role with `scheduler.amazonaws.com` as trusted principal and permission to
   `sqs:SendMessage` to `ScheduledTaskQueue` only. Scope the resource ARN
   narrowly — do not grant `sqs:*` on `*`.

   Create the role, not the schedules. Phase 2 defines what runs on a schedule.

9. **Deploy the web app** in `infra/web.ts` using `sst.aws.Nextjs` pointing at
   `apps/web`. Link every resource the app needs: the secrets from step 3, the
   Cognito pool and client, the bucket, and the queues.

   Map linked values to the exact environment variable names listed in
   _Existing Interfaces to Consume_. `NeonPooledUrl` → `DATABASE_URL_POOLED`
   and `NeonDirectUrl` → `DATABASE_URL_DIRECT`; getting these backwards produces
   application traffic on the direct endpoint (exhausting connections) or DDL
   through the pooler (failing oddly). WS-03's env guard will catch a swap at
   startup — make sure it never fires.

10. **Add root scripts** to `package.json`: `"sst:dev": "sst dev"` and
    `"deploy": "sst deploy"`. Do not add `sst` commands to the four verify
    scripts; `pnpm -r build` must not attempt a deployment.

11. **Verify.** Run `sst deploy --stage dev`, then `sst dev`, and confirm the
    app links and loads. Confirm in the console that all four queues, four DLQs,
    and eight alarms exist.

## Tests

Infrastructure is verified by unit-testing the resource configuration objects
and by post-deploy assertions. Do not deploy inside unit tests.

1. **Every queue has a DLQ** — Assert each of the four queue definitions
   declares a redrive policy naming a distinct DLQ, and that no two queues share
   a DLQ.
2. **Redrive count is bounded** — Assert every `maxReceiveCount` is between 1
   and 10; a message that retries indefinitely never reaches the DLQ, so the
   alarm never fires.
3. **Visibility timeout exceeds handler timeout** — Assert each queue's
   visibility timeout is at least six times its consumer's configured timeout.
4. **Every DLQ has an alarm** — Assert one CloudWatch alarm exists per DLQ on
   `ApproximateNumberOfMessagesVisible` with a threshold of at least 1.
5. **Alarms treat missing data as not breaching** — Assert every alarm sets
   `treatMissingData: 'notBreaching'`, guarding step 7's reasoning.
6. **All seven secrets are declared** — Assert the secrets module exports
   exactly the seven names in step 3.
7. **No secret value is committed** — Assert no file under `infra/` contains a
   string matching a Neon connection URL, an AWS access key, or a Square token
   pattern.
8. **Connection strings map to the right variables** — Assert the web link maps
   `NeonPooledUrl` to `DATABASE_URL_POOLED` and `NeonDirectUrl` to
   `DATABASE_URL_DIRECT`, and that neither is mapped to both.
9. **Every required environment variable is linked** — Assert the web resource
   supplies exactly the six application variables listed in _Existing Interfaces
   to Consume_, and that none of the function-scoped variables
   (`SQUARE_WEBHOOK_SIGNATURE_KEY`, `KEKI_ALLOW_NOOP_PROVIDERS`) is linked to
   the web app. WS-11 maps those onto their functions. A missing variable
   crashes the consumer at module load, not at first use.
   9a. **No handler is attached by this workstream's own deliverable** — Assert
   that at WS-10's completion, `infra/queues.ts` exports queues and DLQs and
   declares no consumer or Function URL. Scope this assertion to WS-10's
   delivery; WS-11 later modifies the same file to attach subscribers, so the
   check must not be written as a permanent repository invariant or it will
   fail once WS-11 lands.
10. **The bucket is private** — Assert the document bucket enables the full
    public-access block, enables versioning and encryption, and declares no
    public policy, no website configuration, and no wildcard CORS origin.
11. **The scheduler role is narrowly scoped** — Assert its policy grants only
    `sqs:SendMessage` and only against the `ScheduledTaskQueue` ARN — not `*`.
12. **No Cognito groups are created** — Assert the auth module declares no
    Cognito group resource, guarding the Postgres-is-role-authority rule.
13. **Production is protected** — Assert the production stage sets
    `protect: true` and `removal: 'retain'`.
14. **Deployed topology matches** _(post-deploy, manual or scripted)_ — After
    `sst deploy --stage dev`, assert via the AWS SDK that four queues, four
    DLQs, the bucket, the user pool, and the scheduler role all exist.

## Acceptance Criteria

1. `sst deploy --stage dev` completes successfully.
2. `sst dev` starts and links `apps/web` to its AWS resources (SC-02).
3. Four SQS queues exist, each with its own DLQ and a bounded `maxReceiveCount`.
4. Eight CloudWatch alarms exist — one per DLQ on message count, one per main
   queue on oldest-message age — all with `treatMissingData: 'notBreaching'`
   and an SNS target.
5. All seven secrets are declared as `sst.Secret`, and no secret value appears
   in any committed file.
6. `DATABASE_URL_POOLED` and `DATABASE_URL_DIRECT` are linked from distinct
   secrets and are not swapped; WS-03's startup guard does not fire.
7. Every environment variable required by `@keki/database`, `@keki/auth`, and
   `apps/web` is supplied through resource linking — the six application
   variables, on the web app only. Function-scoped variables are WS-11's to map.
   7a. The `SquareWebhookSignatureKey` secret and `SquareWebhookQueue` are exported
   for WS-11 to wire; this workstream creates no Function URL.
8. The S3 document bucket blocks all public access, has versioning and
   encryption enabled, and exposes no public policy or website configuration.
9. The Cognito User Pool and client exist; no Cognito group is created.
10. The EventBridge Scheduler execution role grants only `sqs:SendMessage` to
    `ScheduledTaskQueue`.
11. No queue consumer and no Function URL are created **by this workstream** —
    WS-11 owns both and modifies `infra/queues.ts` to add them, so this is a
    condition on WS-10's deliverable, not a lasting repository invariant.
12. `.sst/` and `.open-next/` are gitignored, and `sst` commands are absent from
    the four verify scripts.
13. The production stage sets `protect: true` and a `retain` removal policy.
