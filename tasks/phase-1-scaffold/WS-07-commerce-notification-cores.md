# WS-07: Domain cores — commerce, notification

## Goal

Create `@keki/commerce-core` and `@keki/notification-core` as compiling
skeletons. The notification outbox write and claim paths are implemented for
real, because WS-11's worker drains them and SC-08 depends on that round trip
working. Everything touching Square is interface-shaped only.

No checkout, no payment capture, no Klaviyo flows, no provider implementations.

## Traceability

- **SC-08** — Partially: supplies the outbox claim path the WS-11 worker consumes.
- **SC-11** — All five integration interfaces are referenced with no production implementation.
- **SC-06** — Both packages compile independently.

## Dependencies

- **WS-03** — Database (schema and client).

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Integrations" convention; core code depends on the interface, never a vendor SDK
- `docs/vision.md` — sections "Core Concepts" and "Scope: Phase 1"
- `packages/contracts/src/integrations/square.ts` — the `SquareClient` interface
- `packages/contracts/src/integrations/email.ts`, `sms.ts`, `marketing.ts` — the delivery interfaces
- `packages/database/src/schema/messaging.ts` — the `notification_outbox` table and its `(status, available_at)` index
- `packages/database/src/schema/commerce.ts` — the `payment_records` table
- `packages/database/src/client.ts` — the exported `db` instance

## Package

Two packages: `packages/commerce-core`, `packages/notification-core`.

## Files Touched

**commerce-core**

- `packages/commerce-core/package.json` (NEW)
- `packages/commerce-core/tsconfig.json` (NEW)
- `packages/commerce-core/src/index.ts` (NEW)
- `packages/commerce-core/src/queries.ts` (NEW)
- `packages/commerce-core/src/record-payment.ts` (NEW) — idempotent webhook landing
- `packages/commerce-core/src/commands.ts` (NEW) — deferred checkout
- `packages/commerce-core/src/record-payment.test.ts` (NEW)
- `packages/commerce-core/src/commands.test.ts` (NEW)

**notification-core**

- `packages/notification-core/package.json` (NEW)
- `packages/notification-core/tsconfig.json` (NEW)
- `packages/notification-core/src/index.ts` (NEW)
- `packages/notification-core/src/outbox.ts` (NEW) — enqueue, claim, settle
- `packages/notification-core/src/dispatch.ts` (NEW) — channel → provider routing
- `packages/notification-core/src/providers.ts` (NEW) — no-op provider set
- `packages/notification-core/src/outbox.test.ts` (NEW)
- `packages/notification-core/src/dispatch.test.ts` (NEW)

## Existing Interfaces to Consume

From `@keki/contracts` (WS-02) — the delivery interfaces this package routes to.
Implementations are Phase 2; only the shapes exist:

```ts
export interface TransactionalEmailProvider {
  send(input: {
    to: string;
    templateKey: string;
    payload: Record<string, unknown>;
    idempotencyKey: string;
  }): Promise<{ providerMessageId: string }>;
}

export interface SmsProvider {
  send(input: {
    to: string;
    body: string;
    idempotencyKey: string;
  }): Promise<{ providerMessageId: string }>;
}

export interface MarketingProvider {
  identify(input: { customerId: CustomerId; traits: Record<string, unknown> }): Promise<void>;
  track(input: {
    customerId: CustomerId;
    event: string;
    properties: Record<string, unknown>;
  }): Promise<void>;
  subscribe(input: { customerId: CustomerId; listId: string }): Promise<void>;
  /** Delivery method — same shape as email/SMS so dispatch is uniform. */
  send(input: {
    to: string;
    templateKey: string;
    payload: Record<string, unknown>;
    idempotencyKey: string;
  }): Promise<{ providerMessageId: string }>;
}

export interface SquareClient {
  createCheckout(input: {
    reservationId: ReservationId;
    amountCents: number;
    currency: string;
    idempotencyKey: string;
  }): Promise<{ checkoutUrl: string; providerPaymentId: string }>;
  verifyWebhookSignature(input: { rawBody: string; signature: string }): Promise<boolean>;
}
```

From `@keki/database` (WS-03) — the outbox table. The `(status, available_at)`
index exists specifically for the claim query below:

```ts
export const notificationOutbox = pgTable('notification_outbox', {
  id: uuid('id').primaryKey().defaultRandom(),
  channel: notificationChannelEnum('channel').notNull(),
  templateKey: text('template_key').notNull(),
  recipientCustomerId: uuid('recipient_customer_id').references(() => customers.id),
  recipientAddress: text('recipient_address').notNull(),
  payload: jsonb('payload').notNull(),
  status: notificationStatusEnum('status').notNull().default('PENDING'),
  attempts: integer('attempts').notNull().default(0),
  availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  claimedBy: text('claimed_by'),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  lastError: text('last_error'),
});

export const paymentRecords = pgTable('payment_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  providerPaymentId: text('provider_payment_id').notNull().unique(),
  amountCents: integer('amount_cents').notNull(),
  status: paymentStatusEnum('status').notNull(),
  rawPayload: jsonb('raw_payload'),
  // ...
});
```

## Implementation Steps

1. **Scaffold both packages** per the WS-01 convention. Each depends on
   `@keki/contracts` and `@keki/database` only. Neither may depend on the other,
   on any `*-core` package, or on a vendor SDK — no `square`, no
   `@aws-sdk/client-ses`, no Klaviyo client.

2. **Implement the outbox enqueue** in `notification-core/src/outbox.ts`:

   ```ts
   export declare function enqueueNotification(input: {
     channel: NotificationChannel;
     templateKey: string;
     recipientAddress: string;
     recipientCustomerId?: CustomerId;
     payload: Record<string, unknown>;
     availableAt?: Date;
   }): Promise<NotificationOutboxEntry>;
   ```

   Insert with `status: 'PENDING'` and `attempts: 0`. This is the write path
   every future feature uses to send anything.

3. **Implement the claim path** — the important one, because WS-11's worker and
   SC-08 depend on it:

   ```ts
   /** Atomically leases up to `limit` due notifications to this worker. */
   export declare function claimDueNotifications(input: {
     limit: number;
     claimedBy: string; // invocation identifier, e.g. the Lambda request id
     now?: Date;
   }): Promise<readonly NotificationOutboxEntry[]>;
   ```

   Implement it as a single
   `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)` statement that
   sets `status = 'CLAIMED'`, `claimed_at = now()`, and `claimed_by`, returning
   the affected rows via `RETURNING`.

   `FOR UPDATE SKIP LOCKED` is not optional. Two concurrent workers running a
   naive select-then-update will both claim the same rows and send duplicate
   messages to real customers. The inner select's predicate must be
   `status = 'PENDING' AND available_at <= now()`, matching the WS-03 index
   exactly.

   The `CLAIMED` state is what makes the lease work. Row-level locks last only
   for the transaction, so once the claim commits, nothing but a status change
   would stop the next worker from selecting the same row while the first is
   still dispatching. `CLAIMED` is non-terminal, so it also cannot be confused
   with `SENT`.

   Add the companion reaper for rows whose worker died mid-dispatch:

   ```ts
   /** Returns rows stuck in CLAIMED past the lease window to PENDING. */
   export declare function reclaimStaleClaims(input: {
     olderThanMs: number; // default 15 minutes
     maxAttempts?: number; // default 5 — same cap as markNotificationFailed
     now?: Date;
   }): Promise<number>;
   ```

   `maxAttempts` must default to the same value `markNotificationFailed` uses.
   A reclaimed row and a failed row are on the same retry budget; two different
   caps would mean a row's effective retry limit depended on _how_ it failed.

   Without this, a Lambda timeout strands a notification in `CLAIMED` forever —
   invisible to the claim query and never dead-lettered. Increment `attempts`
   when reclaiming so a row that repeatedly kills its worker eventually reaches
   `DEAD` rather than cycling indefinitely.

4. **Implement settlement** — the two terminal transitions:

   ```ts
   export declare function markNotificationSent(input: {
     id: NotificationId;
     sentAt?: Date;
   }): Promise<void>;

   export declare function markNotificationFailed(input: {
     id: NotificationId;
     error: string;
     maxAttempts?: number; // default 5
     retryDelayMs?: number; // default exponential on attempts
   }): Promise<void>;
   ```

   Both transition out of `CLAIMED` and must clear `claimed_at`/`claimed_by`.
   `markNotificationSent` sets `SENT`; `markNotificationFailed` increments
   `attempts`, records `last_error`, and either reschedules back to `PENDING`
   with `available_at` pushed forward (when `attempts < maxAttempts`) or sets
   `DEAD`. A failure path that retries forever is how an outbox becomes an
   infinite send loop against a broken provider.

5. **Implement dispatch routing** in `notification-core/src/dispatch.ts`:

   ```ts
   export interface NotificationProviders {
     readonly email: TransactionalEmailProvider;
     readonly sms: SmsProvider;
     readonly marketing: MarketingProvider;
   }

   export declare function dispatchNotification(input: {
     entry: NotificationOutboxEntry;
     providers: NotificationProviders;
   }): Promise<{ providerMessageId: string }>;
   ```

   Route on `entry.channel` and pass `entry.id` as the provider
   `idempotencyKey`. All three channels call their provider's `send` — including
   `MARKETING`, which is why `MarketingProvider` carries a `send` alongside
   `identify`/`track`/`subscribe`. Providers arrive as a parameter — do not
   import or construct them, so WS-11 and the tests can inject doubles.

   Make the channel switch exhaustive with a `never` check on the default
   branch, so adding a channel to contracts breaks the build here rather than
   silently dropping messages.

6. **Provide no-op providers** in `notification-core/src/providers.ts`:
   `createNoopProviders(): NotificationProviders`. Each method logs and returns
   a synthetic `providerMessageId` prefixed `noop-`. These satisfy SC-11 (no
   production implementation) while letting WS-11 prove the full path end to
   end. Add a header comment stating these must be replaced in Phase 2, and make
   them refuse to run when `NODE_ENV === 'production'` unless an explicit
   `KEKI_ALLOW_NOOP_PROVIDERS` flag is set — a silent no-op in production is a
   customer-communication outage that looks like success.

7. **Implement idempotent payment landing** in
   `commerce-core/src/record-payment.ts`:

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

   Implement as an upsert on the unique `provider_payment_id`, returning
   `created: false` on a repeat. Square redelivers webhooks; without this,
   WS-11's handler double-writes payment rows.

8. **Declare deferred commerce commands** in `commerce-core/src/commands.ts` —
   `startCheckout`, `capturePayment`, `refundPayment` — each throwing
   `NotImplementedInPhase1`. Each takes a `SquareClient` as a parameter so the
   dependency direction is visible even while unimplemented.

9. **Implement commerce queries** in `commerce-core/src/queries.ts`:
   `getPaymentByProviderId`, `listPaymentsForHousehold`.

10. **Write barrels** and verify all four scripts for both packages.

## Tests

Database-touching tests run against a Neon test branch; the rest use stubs.

1. **`enqueueNotification` defaults correctly** — Assert a new entry has
   `status: 'PENDING'`, `attempts: 0`, and `availableAt` at or before now.
2. **`claimDueNotifications` skips future entries** — Enqueue one with
   `availableAt` an hour ahead; assert it is not returned.
3. **`claimDueNotifications` skips non-pending entries** — Seed `SENT`,
   `DEAD`, and `CLAIMED` rows; assert none is claimed. The `CLAIMED` case is
   the one that matters: a row another worker is currently dispatching must be
   invisible to this query.
4. **`claimDueNotifications` respects the limit** — Seed 10 due entries, claim
   with `limit: 3`; assert exactly 3 are returned.
5. **Concurrent claims do not overlap** _(integration)_ — Seed 10 due entries;
   run two `claimDueNotifications({ limit: 10 })` calls concurrently; assert the
   union of returned ids has no duplicates and totals 10. This is the test that
   proves `SKIP LOCKED` is present and correct.
6. **`markNotificationSent` is terminal** — Assert status becomes `SENT`,
   `sentAt` is populated, and `claimedAt`/`claimedBy` are cleared.
   6a. **Claiming sets the lease fields** — Assert a claimed row has
   `status: 'CLAIMED'`, a non-null `claimedAt`, and `claimedBy` equal to the
   supplied invocation id.
   6b. **`reclaimStaleClaims` recovers abandoned rows** — Seed a `CLAIMED` row with
   `claimedAt` 30 minutes old; run the reaper with a 15-minute window; assert
   the row returns to `PENDING`, `attempts` increments, and it is claimable
   again. Assert a row claimed 1 minute ago is left alone.
   6c. **Repeated reclaim eventually dead-letters** — Reclaim a row past
   `maxAttempts`; assert it becomes `DEAD` rather than cycling forever.
7. **`markNotificationFailed` reschedules below the attempt cap** — With
   `attempts: 1` and `maxAttempts: 5`, assert status returns to `PENDING`,
   `attempts` becomes 2, `availableAt` moves forward, and `lastError` is stored.
8. **`markNotificationFailed` dead-letters at the cap** — With
   `attempts: 4` and `maxAttempts: 5`, assert status becomes `DEAD` and the row
   is no longer claimable.
9. **`dispatchNotification` routes each channel to its provider** — With spy
   providers, assert an `EMAIL` entry calls only `email.send`, `SMS` only
   `sms.send`, and `MARKETING` only the marketing provider.
10. **`dispatchNotification` passes the entry id as the idempotency key** —
    Assert the spy received `idempotencyKey === entry.id`.
11. **Channel switch is exhaustive** — Add a `@ts-expect-error` case proving an
    unhandled channel fails to typecheck via the `never` branch.
12. **No-op providers refuse production** — With `NODE_ENV=production` and no
    override flag, assert `createNoopProviders()` throws.
13. **`recordPaymentFromWebhook` is idempotent** _(integration)_ — Call twice
    with the same `providerPaymentId`; assert the first returns
    `created: true`, the second `created: false`, and exactly one
    `payment_records` row exists.
14. **Deferred commerce commands throw** — Assert `startCheckout`,
    `capturePayment`, and `refundPayment` each reject with
    `NotImplementedInPhase1`.
15. **No vendor SDK is present** — Assert neither `package.json` declares a
    Square, SES, Twilio, or Klaviyo dependency.

## Acceptance Criteria

1. Both packages compile, lint, test, and build via their four scripts.
2. Neither package depends on the other, on any other `*-core` package, or on a
   vendor SDK.
3. `claimDueNotifications` issues a single atomic statement using
   `FOR UPDATE SKIP LOCKED`, with inner predicate
   `status = 'PENDING' AND available_at <= now()`, sets `CLAIMED` plus
   `claimed_at`/`claimed_by`, and passes concurrency test 5.
4. `markNotificationFailed` dead-letters at the attempt cap and cannot retry
   indefinitely; both settle functions clear the lease fields.
   4a. `reclaimStaleClaims` returns rows abandoned past the lease window to
   `PENDING`, increments `attempts`, and dead-letters at the cap (tests 6b,
   6c). No notification can be stranded in `CLAIMED` indefinitely.
5. `dispatchNotification` receives providers by parameter, never by import, and
   its channel switch is exhaustive via a `never` check.
6. `createNoopProviders` throws in production without an explicit override flag.
7. `recordPaymentFromWebhook` upserts on the unique `provider_payment_id` and
   reports `created` accurately.
8. All deferred commerce commands throw `NotImplementedInPhase1` and accept
   their `SquareClient` dependency as a parameter.
9. No Square checkout, payment capture, or Klaviyo flow logic exists in either
   package.
10. `pnpm -r typecheck` passes workspace-wide after these packages are added.
