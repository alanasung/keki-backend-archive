# WS-11: Lambda workers and queue wiring

## Goal

Create the four standalone Lambda handlers in `functions/` and subscribe them to
the queues WS-10 provisioned. Each handler imports the domain packages
**directly** — proving the architectural claim that one core serves both the
Next.js runtime and Lambda, with no Lambda per package.

This workstream delivers SC-08: a message published to SQS is consumed by a
deployed worker.

## Traceability

- **SC-08** — A sample message published to SQS is consumed by its deployed worker.
- **SC-14** — Confirms DLQ routing works by exercising the failure path.
- **SC-11** — Handlers consume the integration interfaces without implementing them.
- **SC-06** — Each function package compiles independently.

## Dependencies

- **WS-07** — Commerce and notification cores (the outbox claim path and payment landing).
- **WS-10** — SST infrastructure (the queues to subscribe to).

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Module boundaries" (no Lambda per package) and "Delivery" conventions
- `docs/vision.md` — "Architecture" and "API Surface" (the four handlers)
- `packages/notification-core/src/outbox.ts` — `claimDueNotifications`, `markNotificationSent`, `markNotificationFailed`
- `packages/notification-core/src/dispatch.ts` — `dispatchNotification` and `NotificationProviders`
- `packages/notification-core/src/providers.ts` — `createNoopProviders`
- `packages/commerce-core/src/record-payment.ts` — `recordPaymentFromWebhook`
- `packages/contracts/src/integrations/square.ts` — `SquareClient.verifyWebhookSignature`
- `infra/queues.ts` — the four queues and their DLQs

## Package

Four packages: `functions/square-webhook`, `functions/notification-worker`,
`functions/reconciliation-worker`, `functions/scheduled-task-worker`. Also
modifies `infra/queues.ts` to attach subscribers.

## Files Touched

- `functions/square-webhook/package.json` (NEW)
- `functions/square-webhook/tsconfig.json` (NEW)
- `functions/square-webhook/src/http.ts` (NEW) — Function URL ingress: verify and enqueue
- `functions/square-webhook/src/consumer.ts` (NEW) — SquareWebhookQueue consumer
- `functions/square-webhook/src/verify-signature.ts` (NEW) — timing-safe HMAC
- `functions/square-webhook/src/http.test.ts` (NEW)
- `functions/square-webhook/src/consumer.test.ts` (NEW)
- `functions/notification-worker/package.json` (NEW)
- `functions/notification-worker/tsconfig.json` (NEW)
- `functions/notification-worker/src/handler.ts` (NEW)
- `functions/notification-worker/src/handler.test.ts` (NEW)
- `functions/reconciliation-worker/package.json` (NEW)
- `functions/reconciliation-worker/tsconfig.json` (NEW)
- `functions/reconciliation-worker/src/handler.ts` (NEW)
- `functions/reconciliation-worker/src/handler.test.ts` (NEW)
- `functions/scheduled-task-worker/package.json` (NEW)
- `functions/scheduled-task-worker/tsconfig.json` (NEW)
- `functions/scheduled-task-worker/src/handler.ts` (NEW)
- `functions/scheduled-task-worker/src/handler.test.ts` (NEW)
- `packages/contracts/src/messages.ts` (NEW) — queue message envelopes
- `packages/contracts/src/index.ts` (MODIFY) — re-export the message envelopes from the barrel
- `infra/queues.ts` (MODIFY) — attach the four subscribers
- `scripts/publish-sample-message.ts` (NEW) — the SC-08 round-trip proof

## Existing Interfaces to Consume

From `@keki/notification-core` (WS-07). `claimDueNotifications` is atomic and
uses `FOR UPDATE SKIP LOCKED`, so concurrent worker invocations do not
double-send:

```ts
export declare function claimDueNotifications(input: {
  limit: number;
  claimedBy: string; // invocation identifier; leases the row
  now?: Date;
}): Promise<readonly NotificationOutboxEntry[]>;

/** Returns rows stuck in CLAIMED past the lease window to PENDING. */
export declare function reclaimStaleClaims(input: {
  olderThanMs: number;
  maxAttempts?: number;
  now?: Date;
}): Promise<number>;

export declare function markNotificationSent(input: {
  id: NotificationId;
  sentAt?: Date;
}): Promise<void>;

export declare function markNotificationFailed(input: {
  id: NotificationId;
  error: string;
  maxAttempts?: number;
  retryDelayMs?: number;
}): Promise<void>;

export interface NotificationProviders {
  readonly email: TransactionalEmailProvider;
  readonly sms: SmsProvider;
  readonly marketing: MarketingProvider;
}

export declare function dispatchNotification(input: {
  entry: NotificationOutboxEntry;
  providers: NotificationProviders;
}): Promise<{ providerMessageId: string }>;

/** Throws in production unless KEKI_ALLOW_NOOP_PROVIDERS is set. */
export declare function createNoopProviders(): NotificationProviders;
```

From `@keki/commerce-core` (WS-07) — idempotent on `providerPaymentId`, which
is what makes Square's webhook redelivery safe:

```ts
export declare function recordPaymentFromWebhook(input: {
  providerPaymentId: string;
  householdId: HouseholdId;
  reservationId?: ReservationId;
  amountCents: number;
  currency: string;
  status: PaymentStatus;
  rawPayload: Record<string, unknown>;
  occurredAt: Date;
}): Promise<{ record: PaymentRecord; created: boolean }>;
```

The AWS Lambda SQS contract — partial batch failure requires returning
`batchItemFailures`:

```ts
interface SQSBatchResponse {
  batchItemFailures: { itemIdentifier: string }[];
}
```

## Implementation Steps

1. **Define message envelopes** in `packages/contracts/src/messages.ts`. Every
   queue message carries a versioned envelope so Phase 2 can evolve payloads:

   ```ts
   export interface QueueMessage<TType extends string, TPayload> {
     readonly version: 1;
     readonly type: TType;
     readonly occurredAt: string; // ISO 8601
     readonly payload: TPayload;
   }

   export type NotificationMessage = QueueMessage<'notification.drain', { limit?: number }>;
   export type ReconciliationMessage = QueueMessage<'reconciliation.run', { since?: string }>;
   export type ScheduledTaskMessage = QueueMessage<'scheduled.tick', { taskKey: string }>;

   /** Enqueued by the Square HTTP ingress after signature verification. */
   export type SquareWebhookMessage = QueueMessage<
     'square.webhook',
     {
       readonly rawBody: string;
       readonly headers: Record<string, string>;
       readonly verifiedAt: string; // ISO 8601
     }
   >;
   ```

   `SquareWebhookQueue` carries an envelope like every other queue. The ingress
   wraps the raw body rather than enqueuing it bare, so the consumer validates
   the same way every other handler does and acceptance criterion 3 holds for
   all four queues. `verifiedAt` records that the signature was checked at the
   boundary — the consumer must never re-derive trust from the payload itself.

   Add a Zod schema per envelope, and **re-export them from
   `packages/contracts/src/index.ts`**. WS-02's barrel does not know about this
   file and the package exposes only the `.` subpath, so without the barrel edit
   the handlers cannot import these types through `@keki/contracts` at all.

   Handlers validate before acting — an unvalidated queue payload is untrusted
   input.

   For `ScheduledTaskMessage`, keep `taskKey` a plain `string` in the envelope
   schema but define the closed set separately:

   ```ts
   export const KNOWN_TASK_KEYS = ['notification.drain'] as const;
   export type KnownTaskKey = (typeof KNOWN_TASK_KEYS)[number];
   export declare function isKnownTaskKey(value: string): value is KnownTaskKey;
   ```

   This two-tier shape is what lets the worker satisfy both of its requirements
   at once: the envelope accepts any `string` so an unrecognized key from a
   stale schedule parses and is handled gracefully, while the handler narrows
   with `isKnownTaskKey` before a switch that is exhaustive over `KnownTaskKey`
   and therefore admits a `never` default. A single closed union in the schema
   would reject unknown keys outright and dead-letter them; a bare `string`
   could never narrow to `never`.

2. **Scaffold the four function packages** per the WS-01 convention, each with
   the four required scripts. Dependencies are the domain packages they actually
   use — not all of them. `square-webhook` does not depend on
   `notification-core`.

3. **Enable partial batch failure on every SQS handler.** Return
   `batchItemFailures` listing only the messages that failed, and configure the
   subscription with `reportBatchItemFailures`.

   Without this, one poison message in a batch of ten causes all ten to be
   redelivered, so nine already-processed messages are handled again. This is
   the single most common SQS-consumer defect and it is much cheaper to get
   right now than to debug later.

4. **Implement `notification-worker`.** This is the handler that satisfies
   SC-08:

   - Validate the envelope.
   - **First, call `reclaimStaleClaims({ olderThanMs: 900_000 })`.** Running the
     reaper at the head of every invocation is what makes it reachable in
     production — otherwise rows abandoned by a timed-out worker sit in
     `CLAIMED` forever, invisible to the claim query and never dead-lettered.
     Log the number reclaimed; a non-zero count that persists is a signal the
     dispatch path is timing out.
   - Then call `claimDueNotifications({ limit, claimedBy })` (limit default 25),
     passing the Lambda request id as `claimedBy` so a stranded lease is
     traceable to the invocation that took it.
   - For each claimed entry, call `dispatchNotification` with providers from
     `createNoopProviders()`.
   - On success → `markNotificationSent`. On failure → `markNotificationFailed`
     with the error message.
   - A single entry's failure must not fail the batch: catch per entry, and add
     the SQS message to `batchItemFailures` only if the claim itself failed.

   Set `KEKI_ALLOW_NOOP_PROVIDERS` in the dev stage only. In production the
   no-op providers must throw — a silent no-op is a customer-communication
   outage that reports success.

5. **Implement `square-webhook` as two entry points in one package.** Square
   delivers over HTTP, but the durable processing belongs on a queue, so this
   package exports both halves:

   ```ts
   // functions/square-webhook/src/http.ts — Function URL ingress
   export declare function httpHandler(event: LambdaFunctionURLEvent): Promise<{
     statusCode: number;
   }>;

   // functions/square-webhook/src/consumer.ts — SquareWebhookQueue consumer
   export declare function queueHandler(event: SQSEvent): Promise<SQSBatchResponse>;
   ```

   Two Lambda entry points in one package does not violate the "no Lambda per
   package" rule — that rule forbids a Lambda per _domain_ package, not a second
   entry point for a genuinely different trigger.

   **`httpHandler`** — receives untrusted input from the public internet:

   - **Verify the signature before parsing anything.** Call
     `verifyWebhookSignature({ rawBody, signature })` against the raw body and
     return 401 on failure. Do not parse, log, or persist an unverified payload.
   - On success, wrap the raw body and headers in a `SquareWebhookMessage`
     envelope, enqueue it to `SquareWebhookQueue`, and return 200 immediately.
     Square retries on non-2xx, so slow synchronous processing here causes
     duplicate deliveries.
   - Nothing else. No database write, no payment logic.

   **`queueHandler`** — drains `SquareWebhookQueue`, validates the
   `SquareWebhookMessage` envelope with its Zod schema, parses the verified
   payload, and calls `recordPaymentFromWebhook`, relying on its idempotency for
   redelivery. Returns `batchItemFailures`.

6. **Scope the signature verification honestly.** SC-11 forbids production
   integration implementations, but an HTTP endpoint that accepts unverified
   payloads is not a safe thing to deploy, so Phase 1 takes a narrow, explicit
   exception:

   - Implement generic HMAC-SHA256 verification over the raw body against
     `SQUARE_WEBHOOK_SIGNATURE_KEY`, using `crypto.timingSafeEqual` — never
     `===`, which leaks the comparison position through timing.
   - This is **not** Square's actual scheme, which signs the concatenation of
     the notification URL and the body. Mark it `TODO(phase-2)` and state that
     a real Square integration requires implementing that exact construction.
   - Because the verification is not yet Square-compatible, the Function URL
     must **not** be publicly reachable in Phase 1. **This workstream creates
     it** (WS-10 deliberately does not, to avoid a dependency cycle) with
     `authType: AWS_IAM` — not `NONE`. The round trip is exercised by invoking
     it with signed AWS credentials, not by pointing Square at it.
   - Map the `SquareWebhookSignatureKey` secret exported by WS-10 onto this
     function as `SQUARE_WEBHOOK_SIGNATURE_KEY`.

   Record this as the one deliberate SC-11 exception. Do **not** implement
   checkout, capture, or refund logic.

7. **Implement `reconciliation-worker`** as a structural skeleton: validate the
   envelope, log the requested window, return an empty batch-failure list. Add a
   `TODO(phase-2)` describing the intended reconciliation — compare
   `payment_records` against Square and against reservation state. Do not write
   reconciliation logic.

8. **Implement `scheduled-task-worker`**: validate the envelope, then narrow
   with `isKnownTaskKey`. An unrecognized key logs and returns success — a stale
   schedule must not fill the DLQ. A known key enters a switch that is
   exhaustive over `KnownTaskKey` with a `never` default, handling the one real
   task, `notification.drain`, by enqueuing to the notification queue.

   This gives the EventBridge Scheduler role from WS-10 a real target while
   keeping scheduling policy in Phase 2.

9. **Attach subscribers** in `infra/queues.ts`. Each handler subscribes to its
   queue with `reportBatchItemFailures` enabled, a timeout consistent with the
   visibility timeout WS-10 set (visibility ≥ 6× timeout), and links to the
   secrets and resources it needs.

   **Name every function-to-secret mapping explicitly.** WS-10 links the
   database URLs to the web app only; every worker that touches domain code
   needs its own linkage, and `@keki/database` validates both URLs eagerly at
   module load — so an unlinked worker does not fail on first query, it fails to
   start at all. Required mappings:

   | Function                             | Environment variables                                                                                  |
   | ------------------------------------ | ------------------------------------------------------------------------------------------------------ |
   | `square-webhook` (both entry points) | `DATABASE_URL_POOLED`, `DATABASE_URL_DIRECT`, `SQUARE_WEBHOOK_SIGNATURE_KEY`                           |
   | `notification-worker`                | `DATABASE_URL_POOLED`, `DATABASE_URL_DIRECT`, `KEKI_ALLOW_NOOP_PROVIDERS` (non-production stages only) |
   | `reconciliation-worker`              | `DATABASE_URL_POOLED`, `DATABASE_URL_DIRECT`                                                           |
   | `scheduled-task-worker`              | `DATABASE_URL_POOLED`, `DATABASE_URL_DIRECT`                                                           |

   Link each function narrowly beyond that: `square-webhook` gets the Square
   signature key, not the Klaviyo key.

10. **Write the round-trip script** `scripts/publish-sample-message.ts`. It
    enqueues a notification row, publishes a `notification.drain` message to the
    queue, polls until the row reaches `SENT`, and exits non-zero on timeout.
    This is the executable form of SC-08 — the criterion is "consumed", which a
    deployment alone does not demonstrate.

11. **Verify.** Run all four scripts per function package, deploy, then run the
    round-trip script against the dev stage.

## Tests

Handler tests invoke the exported handler with synthetic SQS events and stubbed
domain modules. The round trip is an integration test against a deployed stage.

1. **Envelope validation rejects malformed messages** — For each handler, assert
   a body with a missing `type`, a wrong `version`, or invalid JSON is rejected
   without calling any domain function.
2. **Notification worker dispatches each claimed entry** — Stub
   `claimDueNotifications` to return three entries; assert
   `dispatchNotification` is called three times and `markNotificationSent`
   three times.
   2a. **The reaper runs before claiming** — Assert `reclaimStaleClaims` is called
   on every invocation and that it is called _before_ `claimDueNotifications`,
   so rows recovered this invocation are eligible for it.
3. **A single dispatch failure does not fail the batch** — Stub the second of
   three dispatches to reject; assert entries one and three are marked sent, the
   second is marked failed with the error text, and the handler resolves rather
   than throwing.
4. **Dispatch failure records the error** — Assert `markNotificationFailed`
   receives the rejection message, so a stuck outbox row is diagnosable.
5. **Partial batch failure is reported correctly** — Given a two-message SQS
   event where the first message's claim throws, assert the response
   `batchItemFailures` contains exactly that message's `messageId` and not the
   second's. This guards step 3's reasoning.
6. **Every handler returns `batchItemFailures`** — Assert each of the four
   handlers returns an object with a `batchItemFailures` array, even on full
   success.
7. **Square webhook rejects an invalid signature** — Assert a request with a
   wrong signature returns 401 and that `recordPaymentFromWebhook` is never
   called.
8. **Square webhook does not parse before verifying** — Assert that for an
   invalid signature, no JSON parsing of the body occurs (spy on the parse path)
   and nothing is persisted.
9. **Square webhook uses timing-safe comparison** — Assert the verification path
   calls `crypto.timingSafeEqual` and contains no `===` comparison of signature
   strings.
10. **Square webhook is idempotent on redelivery** — Deliver the same verified
    payload twice; assert `recordPaymentFromWebhook` reports `created: true`
    then `created: false`, and that the handler succeeds both times.
11. **Scheduled worker switch is exhaustive over known keys** — Add a
    `@ts-expect-error` case proving that adding a member to `KNOWN_TASK_KEYS`
    without handling it fails to typecheck via the `never` default.
12. **Unknown task key does not fail the message** — Assert an unrecognized
    `taskKey` logs and returns success rather than dead-lettering, so a stale
    schedule cannot fill the DLQ.
13. **No-op providers are refused in production** — With `NODE_ENV=production`
    and no override, assert the notification worker fails fast at startup rather
    than silently sending nothing.
14. **Handlers import cores directly** — Assert each function package depends on
    the domain packages it uses and that no function imports another function.
    14a. **Every function is linked to the database URLs** — Assert each of the four
    functions receives both `DATABASE_URL_POOLED` and `DATABASE_URL_DIRECT`,
    matching the table in step 9. A worker missing them cannot start, and the
    failure surfaces only after deployment.
15. **No Lambda per package** — Assert exactly four packages exist under
    `functions/`, guarding the `AGENTS.md` rule.
16. **Round trip: publish and consume** _(integration, SC-08)_ — Against the
    deployed dev stage, run `scripts/publish-sample-message.ts`; assert the
    seeded outbox row reaches `SENT` within the timeout and the script exits 0.
17. **Failure routes to the DLQ** _(integration)_ — Publish a message that fails
    deterministically; assert that after `maxReceiveCount` deliveries it appears
    in the DLQ and the CloudWatch alarm from WS-10 transitions to `ALARM`.

## Acceptance Criteria

1. All four function packages compile, lint, test, and build.
2. Exactly four packages exist under `functions/`; no function imports another
   function.
3. Every handler validates its message envelope with a Zod schema before acting.
4. Every SQS handler returns `batchItemFailures` and its subscription enables
   `reportBatchItemFailures`.
5. A single entry failure in the notification worker does not fail the whole
   batch (test 3), and partial failures are reported accurately (test 5).
   5a. The notification worker invokes `reclaimStaleClaims` before claiming on
   every invocation, so no outbox row can be stranded in `CLAIMED` (test 2a).
6. The Square webhook verifies the signature against the raw body before any
   parsing or persistence, using `crypto.timingSafeEqual`.
7. The Square webhook is idempotent across redelivery via
   `recordPaymentFromWebhook`.
8. The scheduled worker narrows with `isKnownTaskKey`, its switch is exhaustive
   over `KnownTaskKey` with a `never` default, and an unknown key returns
   success rather than dead-lettering.
   8a. The queue message envelopes are re-exported from `@keki/contracts`'s barrel
   and importable by all four function packages.
9. The reconciliation worker contains no reconciliation logic, only a validated
   skeleton and a `TODO(phase-2)`.
10. `scripts/publish-sample-message.ts` demonstrates the full publish-and-consume
    round trip against a deployed stage and exits non-zero on failure (SC-08).
11. Failed messages reach their DLQ and trigger the corresponding WS-10 alarm
    (test 17).
12. No Square checkout, capture, refund, or Klaviyo flow logic exists in any
    handler.
13. `KEKI_ALLOW_NOOP_PROVIDERS` is set only in non-production stages.
14. Every function is linked to both database URLs per the step 9 table, and
    `SQUARE_WEBHOOK_SIGNATURE_KEY` is mapped onto `square-webhook` only.
