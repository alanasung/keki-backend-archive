# WS-11: Infrastructure — Square secrets, catalog schedule, public Function URL

## Goal

Provision what this program needs in AWS: the new Square secrets, the catalog
refresh schedule, the hold-expiry schedule, and the change that makes the Square
webhook Function URL publicly reachable.

Small in code, disproportionate in consequence. Phase 1 made the Function URL
`AWS_IAM`-authed **specifically because** its signature verification was not
Square-compatible. This workstream removes that protection, so it may only land
after WS-03 has replaced the verifier and WS-10 has wired it in.

## Traceability

- **SC-11** — The Square webhook Function URL is publicly reachable and rejects
  unsigned requests.
- **SC-12** — Partially: the scheduled half of catalog sync.

## Dependencies

- **WS-03** — square-client (the real verifier must exist before the URL opens).
- **WS-04** — catalog-core (the `catalog.sync` task key the schedule triggers).
- **WS-06** — reservation-core (the `reservation.expire-holds` task key).
- **WS-10** — webhook fulfillment (wires the real verifier into the HTTP entry
  point). Opening the Function URL before this lands would expose an
  unauthenticated endpoint that writes payment records.

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Delivery"; SST owns all provisioning, every queue has a DLQ and
  an alarm, nothing is created by hand
- `docs/vision.md` — "Scope: Phase 1" infrastructure list
- `docs/as-built.md` — "Infrastructure" and the Function-URL limitation
- `infra/secrets.ts` — `SECRET_NAMES` and the single-declaration rule
- `infra/queues.ts` — `attachWorkers`, the Function URL definition, and the
  comment explaining why it is IAM-authed
- `infra/scheduler.ts` — the EventBridge Scheduler execution role
- `infra/alarms.ts` — existing queue alarms
- `infra/web.ts` — `WEB_ENV_MAPPING` and the reserved-`AWS_REGION` warning
- `infra/index.ts` — `createInfra` composition and the account assertion
- `docs/environment.md` — the environment contract to keep in step

## Package

`infra`

## Files Touched

- `infra/secrets.ts` (MODIFY) — add the new secret names
- `infra/queues.ts` (MODIFY) — Function URL auth, notification URL, Square env
- `infra/scheduler.ts` (MODIFY) — catalog and expiry schedules
- `infra/alarms.ts` (MODIFY) — signature-failure alarm
- `infra/web.ts` (MODIFY) — base URL and cart secret for the app
- `infra/secrets.test.ts` (MODIFY)
- `infra/queues.test.ts` (MODIFY)
- `infra/scheduler.test.ts` (NEW)

## Existing Interfaces to Consume

The secret registry, declared once so both `web.ts` and `queues.ts` link the
same instances:

```ts
export const SECRET_NAMES = [
  "NeonPooledUrl",
  "NeonDirectUrl",
  "SquareAccessToken",
  "SquareWebhookSignatureKey",
  "KlaviyoApiKey",
  "WaiverProviderApiKey",
  "KioskDeviceToken",
] as const;

export type SecretName = (typeof SECRET_NAMES)[number];
export type Secrets = Record<SecretName, sst.Secret>;
```

The Function URL as it stands, with the comment stating the exact condition this
workstream must satisfy before changing it:

```ts
// The one deliberate SC-11 exception (see functions/square-webhook/src/verify-signature.ts):
// Phase 1's signature verification is not Square-compatible, so the Function
// URL created here must never accept unauthenticated requests.
const squareWebhookHttp = new sst.aws.Function(SQUARE_WEBHOOK_HTTP_DEFINITION.functionName, {
  handler: SQUARE_WEBHOOK_HTTP_DEFINITION.handler,
  link: [secrets.NeonPooledUrl, secrets.NeonDirectUrl, secrets.SquareWebhookSignatureKey, squareWebhookQueue],
  environment: {
    SQUARE_WEBHOOK_SIGNATURE_KEY: secrets.SquareWebhookSignatureKey.value,
    SQUARE_WEBHOOK_QUEUE_URL: squareWebhookQueue.url,
  },
  url: { authorization: "iam" },
});
```

The web environment mapping, including the reserved-key warning that also
constrains anything added here:

```ts
// `AWS_REGION` (which `@keki/auth` also reads) is deliberately NOT set: it is
// a reserved Lambda key — CreateFunction rejects it outright.
export const WEB_ENV_MAPPING = {
  DATABASE_URL_POOLED: "NeonPooledUrl",
  DATABASE_URL_DIRECT: "NeonDirectUrl",
  COGNITO_USER_POOL_ID: "cognitoUserPoolId",
  COGNITO_CLIENT_ID: "cognitoClientId",
  KIOSK_DEVICE_TOKEN: "KioskDeviceToken",
} as const;
```

## Implementation Steps

1. **Add secrets** to `SECRET_NAMES`: `SquareEnvironment`, `SquareNotificationUrl`,
   `CartCookieSecret`, and `AppBaseUrl`. `SquareAccessToken` and
   `SquareWebhookSignatureKey` already exist as placeholders and now carry real
   values.

   `AppBaseUrl` is a secret-shaped config value rather than a derived one on
   purpose: WS-13 requires the Square redirect URL to come from server
   configuration and never from a request header.

2. **Link Square configuration into the webhook function** in `queues.ts`. Add
   `SQUARE_ACCESS_TOKEN`, `SQUARE_ENVIRONMENT`, and `SQUARE_NOTIFICATION_URL`.

   `SQUARE_NOTIFICATION_URL` is a **configured secret**, not a derived value.
   The obvious approach — reading it from the function's own `url` output — is
   circular: the Function URL is created *from* the function, so the function's
   environment cannot depend on it. Nothing would deploy.

   Instead: set the secret to the Function URL after the first deploy of a
   stage, and **assert agreement after every deploy** (step 3). That keeps the
   value correct without the cycle.

   The registered value must match Square's dashboard character for character.
   A trailing-slash difference produces a verifier that rejects every genuine
   delivery, and the failure is indistinguishable from an attack.

3. **Add a post-deploy assertion** comparing the `SquareNotificationUrl` secret
   to the actual `squareWebhookUrl` output, failing the deploy on mismatch.
   Place it alongside the existing account assertion in `infra/index.ts`, which
   is the established pattern for a deploy-time invariant.

   This is what makes the configured secret safe. Without it, a redeployed
   stage that mints a new Function URL silently breaks every webhook, and the
   only symptom is a signature-failure alarm that looks like an attack.

3. **Open the Function URL.** Change `url: { authorization: "iam" }` to
   `url: { authorization: "none" }`, and **replace** the Phase 1 comment with
   one recording the new invariant: the endpoint is public and its only
   protection is Square's signature verification in
   `@keki/square-client`, exercised by WS-03 tests 1–8 and WS-10 tests 1–4.

   Do not delete the comment without replacing it. The next person to read this
   file needs to know what is now load-bearing.

4. **Link app configuration into the web function** in `web.ts`: add
   `CART_COOKIE_SECRET` and `APP_BASE_URL` to `WEB_ENV_MAPPING`, the `link`
   array, and the `environment` map, following the existing pattern exactly.

   Do not add `SQUARE_ACCESS_TOKEN` to the web function. The Next.js app creates
   checkouts through Server Actions, which run server-side — but the app also
   needs the token only via the `square-client` it constructs. Add it only if
   WS-09's `checkoutAction` constructs the client in-process; if so, link it the
   same way and never expose it through a `NEXT_PUBLIC_` variable.

5. **Add the schedules** in `scheduler.ts`, targeting `ScheduledTaskQueue`
   through the existing execution role:

   - `catalog.sync` every 15 minutes. This bounds catalog staleness, the
     mitigation named in the program's risk register.
   - `reservation.expire-holds` every 5 minutes. The hold TTL is 15 minutes, so
     a 5-minute sweep returns an abandoned seat within a third of its lifetime.
     A sweep slower than the TTL would leave seats unsellable well past expiry.

   Send the same versioned envelope the worker already parses. Do not invent a
   second message shape.

6. **Add a signature-failure alarm** in `alarms.ts`. Emit a metric filter on the
   webhook function's logs for verification failures and alarm above a
   threshold over 5 minutes.

   Once the URL is public, a burst of failures is either an attack or a
   misconfigured notification URL — and both are invisible without this alarm,
   because a rejected request never reaches a queue or a DLQ.

7. **Keep production guards intact.** Do not weaken the account assertion in
   `infra/index.ts` or the local-production-deploy refusal in `sst.config.ts`.

8. **Verify by deploying to a personal stage.** Run `sst deploy` to a non-production
   stage and confirm the URL is reachable, an unsigned request returns 401, and
   the schedules appear. Infrastructure that has only typechecked is unverified.

9. **Run all four scripts** for `infra`.

## Tests

`infra` uses unit tests over the definition modules, following the existing
`queues.test.ts` and `secrets.test.ts`.

1. **New secrets are declared** — Assert `SECRET_NAMES` contains
   `SquareEnvironment`, `SquareNotificationUrl`, `CartCookieSecret`, and
   `AppBaseUrl`.
2. **Secret names are unique** — Assert no duplicates, preserving the
   declared-once rule.
3. **Webhook function receives Square configuration** — Assert all three Square
   variables are mapped.
4. **Notification URL comes from the secret, not the function output** — Assert
   the environment value references the `SquareNotificationUrl` secret, so no
   self-reference is reintroduced.
4a. **Post-deploy assertion compares secret to Function URL** — Assert the
   assertion exists and fails on a mismatched pair.
4b. **A trailing-slash mismatch is caught** — Feed the assertion a secret
   differing from the output only by a trailing slash; assert it fails.
5. **Function URL authorization is `none`** — Assert the value. **This is
   SC-11's infrastructure half.**
6. **The IAM-exception comment was replaced, not deleted** — Assert the module
   source contains the new invariant text referencing signature verification.
7. **Web function receives cart and base-URL configuration** — Assert both are
   in `WEB_ENV_MAPPING`, `link`, and `environment`.
8. **No secret is exposed as `NEXT_PUBLIC_`** — Assert no mapped key starts with
   `NEXT_PUBLIC_`.
9. **`AWS_REGION` is still not set** — Assert the reserved key is absent,
   preserving the Phase 1 fix.
10. **Both schedules exist with their intervals** — Assert 15 minutes for
    `catalog.sync` and 5 minutes for `reservation.expire-holds`.
11. **Expiry sweep is more frequent than the hold TTL** — Assert the interval is
    strictly less than 15 minutes, encoding the reasoning as a test.
12. **Schedules target `ScheduledTaskQueue`** — Assert the target and that they
    use the existing execution role.
13. **Schedule payloads match the worker's envelope** — Assert the message
    parses with `scheduledTaskMessageSchema`.
14. **Signature-failure alarm exists** — Assert the alarm and its threshold.
15. **Existing queue alarms are unchanged** — Assert Phase 1 alarm assertions
    still pass.
16. **Account assertion is intact** — Assert `EXPECTED_ACCOUNT_ID` is unchanged
    and still asserted.

## Acceptance Criteria

1. `infra` passes all four scripts.
2. `SquareEnvironment`, `SquareNotificationUrl`, `CartCookieSecret`, and
   `AppBaseUrl` are declared once in `SECRET_NAMES` and linked where used.
3. The webhook function receives `SQUARE_ACCESS_TOKEN`, `SQUARE_ENVIRONMENT`,
   and a `SQUARE_NOTIFICATION_URL` sourced from the **secret**, with no
   self-reference to the function's own URL output (test 4).
3a. A post-deploy assertion fails the deploy when the secret and the actual
   Function URL disagree, including by a trailing slash (tests 4a, 4b).
4. The Function URL is `authorization: "none"`, and the Phase 1 IAM comment is
   replaced by one naming signature verification as the sole protection.
5. **WS-10 is declared as a dependency in the manifest, not merely asserted
   here.** Opening the URL against the Phase 1 verifier would expose an
   endpoint that writes payment records.
6. The web function receives `CART_COOKIE_SECRET` and `APP_BASE_URL`, and no
   secret is exposed via `NEXT_PUBLIC_`.
7. `AWS_REGION` remains unset on the web function.
8. `catalog.sync` runs every 15 minutes and `reservation.expire-holds` every 5,
   both targeting `ScheduledTaskQueue` with the existing envelope.
9. A CloudWatch alarm fires on a burst of signature-verification failures.
10. The account assertion and local-production-deploy refusal are untouched.
11. A personal-stage deploy demonstrates a reachable URL that returns 401 for an
    unsigned request.
