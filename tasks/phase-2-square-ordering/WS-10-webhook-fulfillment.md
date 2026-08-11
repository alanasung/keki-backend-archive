# WS-10: Webhook fulfillment — confirm orders and reservations on payment

## Goal

Close the loop: when Square reports a payment, mark the order `PAID` and confirm
every reservation it holds. Replace the Phase 1 placeholder payload schema —
which invented `household_id` and `reservation_id` fields a real Square webhook
does not carry — with resolution through the Square order reference WS-03 sets
at checkout.

Wire WS-03's real signature verification into the HTTP entry point, replacing
the generic HMAC.

This is the workstream where money becomes entitlement. Its two governing
properties are **idempotency** (SQS retries, and Square redelivers) and
**never trusting the payload for identity**.

## Traceability

- **SC-06** — A signed payment webhook moves its matching order to `PAID` and
  writes exactly one `payment_records` row.
- **SC-07** — A paid order containing a class seat confirms its reservation; the
  seat is no longer offered.
- **SC-13** — Replaying the same payment webhook, or resuming it after a
  mid-fulfillment crash, produces exactly one payment record and one
  fulfillment.
- **SC-11** — Partially: the endpoint rejects unsigned requests. WS-11 makes it
  publicly reachable.
- **SC-12** — Partially: handles `catalog.version.updated` to invalidate the
  catalog cache.

## Dependencies

- **WS-03** — square-client (signature verification, payment mapping).
- **WS-04** — catalog-core (introduces the `catalog.sync` task key this handler
  emits; without it the contracts message union does not contain the key).
- **WS-05** — commerce-core (`transitionOrder`, `getOrderBySquareOrderId`).
- **WS-06** — reservation-core (`confirmReservation`).

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Integrations" and "Delivery"
- `docs/vision.md` — "Scope: Phase 2+"; Square is the source of truth for money,
  Postgres for entitlement
- `docs/as-built.md` — "Known Limitations"; the generic HMAC and the placeholder
  payload schema this workstream replaces
- `functions/square-webhook/src/http.ts` — the HTTP entry point and its comment
  on verifying before doing anything else
- `functions/square-webhook/src/consumer.ts` — the queue consumer and its
  `TODO(phase-2)` about the invented payload fields
- `functions/square-webhook/src/verify-signature.ts` — the Phase 1 verifier to
  delete
- `packages/square-client/src/verify-signature.ts` — the WS-03 replacement
- `packages/commerce-core/src/record-payment.ts` — the existing idempotent
  upsert
- `packages/contracts/src/integrations/square.ts` — `squareWebhookEnvelopeSchema`

## Package

`functions/square-webhook`

## Files Touched

- `functions/square-webhook/src/http.ts` (MODIFY) — use the real verifier
- `functions/square-webhook/src/consumer.ts` (MODIFY) — real payload handling
  and fulfillment
- `functions/square-webhook/src/fulfillment.ts` (NEW) — order/reservation
  fulfillment
- `functions/square-webhook/src/verify-signature.ts` (MODIFY) — **deleted**; the
  Phase 1 generic HMAC is removed outright and replaced by
  `@keki/square-client`'s verifier (see step 1 and acceptance criterion 2)
- `functions/square-webhook/package.json` (MODIFY) — depend on
  `@keki/square-client`
- `functions/square-webhook/src/http.test.ts` (MODIFY)
- `functions/square-webhook/src/consumer.test.ts` (MODIFY)
- `functions/square-webhook/src/fulfillment.test.ts` (NEW)

## Existing Interfaces to Consume

The HTTP handler. Its structure is correct — verify first, enqueue, return fast —
and only the verification call changes:

```ts
const SIGNATURE_HEADER = 'x-square-signature';

// Receives untrusted input from the public internet. Verifies the signature
// against the raw body before touching anything else, then enqueues and
// returns immediately — Square retries on non-2xx, so slow synchronous
// processing here would cause duplicate deliveries.
export async function httpHandler(event: LambdaFunctionURLEvent): Promise<{ statusCode: number }> {
  const rawBody = rawBodyOf(event);
  const signature = event.headers[SIGNATURE_HEADER];

  if (
    signature === undefined ||
    !verifyWebhookSignature({ rawBody, signature, signingKey: getSigningKey() })
  ) {
    return { statusCode: 401 };
  }
  // ... enqueue to SQS, return 200
}
```

The consumer's placeholder schema and the `TODO` that names exactly what is
wrong with it — this workstream is what resolves it:

```ts
// TODO(phase-2): A real Square payment webhook carries no `household_id` or
// `reservation_id` — those must be resolved from the order/reference
// metadata Square echoes back from checkout, which Phase 1 does not
// implement. This schema is a placeholder shape ... that a real Square
// payload does not have.
const squarePaymentPayloadSchema = z.object({
  id: z.string(),
  status: z.enum(PAYMENT_STATUSES),
  amount_money: z.object({ amount: z.number().int(), currency: z.string() }),
  household_id: z.string(),
  reservation_id: z.string().optional(),
});
```

The idempotent payment landing already proven in `commerce-core`:

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

The WS-05 and WS-06 entry points, both idempotent by design:

```ts
export declare function getOrderBySquareOrderId(squareOrderId: string): Promise<Order | null>;
export declare function transitionOrder(input: {
  orderId: OrderId;
  to: OrderStatus;
  expect?: OrderStatus;
  patch?: Partial<Pick<Order, 'providerPaymentId'>>;
}): Promise<{ order: Order; changed: boolean }>;
export declare function confirmReservation(input: {
  reservationId: ReservationId;
}): Promise<{ reservation: Reservation; changed: boolean }>;
```

## Implementation Steps

1. **Swap in the real verifier** in `http.ts`. Import from `@keki/square-client`
   and pass `notificationUrl` from a new `SQUARE_NOTIFICATION_URL` variable,
   resolved by the same throw-if-missing pattern as the existing getters.

   Delete `functions/square-webhook/src/verify-signature.ts`. Leaving a
   body-only verifier in the tree invites a future edit to import the wrong one.

   Keep the rest of the handler unchanged — verify, enqueue, return 200 fast.
   That structure is already right.

   The notification URL must exactly match what is registered in Square's
   dashboard, character for character. A trailing-slash difference produces a
   verifier that rejects every genuine delivery, and the failure looks
   identical to an attack.

2. **Replace the placeholder payload schema** in `consumer.ts` with the real
   Square payment shape: `id`, `status`, `amount_money`, `order_id`, and
   `reference_id`. Remove `household_id` and `reservation_id` entirely, along
   with the `TODO(phase-2)`.

3. **Route by event type.** The envelope carries `type`. Handle:

   - `payment.created` / `payment.updated` → payment fulfillment
   - `catalog.version.updated` → enqueue a `catalog.sync` scheduled-task message
   - anything else → log and acknowledge

   Unrecognized event types must **not** be treated as failures. Square sends
   event types we did not subscribe to, and dead-lettering them would fill the
   DLQ and fire the alarm for normal traffic — the same reasoning the
   scheduled-task worker already applies to unknown task keys.

4. **Implement fulfillment** in `fulfillment.ts`:

   ```ts
   export async function fulfillPayment(input: {
     squareOrderId: string;
     providerPaymentId: string;
     amountCents: number;
     currency: string;
     status: PaymentStatus;
     rawPayload: Record<string, unknown>;
     occurredAt: Date;
   }): Promise<{ orderId: OrderId | null; confirmed: number }>;
   ```

   a. Resolve our order with `getOrderBySquareOrderId`. **Identity comes from
      our database, keyed by the reference Square echoes back — never from a
      payload field.** A payload-supplied household id would let anyone who can
      forge a webhook body attribute a payment to any household. The signature
      makes the message authentic; it does not make its contents authoritative
      about our internal ids.

   b. If no order matches, log a warning and acknowledge. Payments can exist for
      orders taken at the physical register, which this system did not create.
      Dead-lettering those would alarm on ordinary cafe business.

   c. Call `recordPaymentFromWebhook` with the order's `householdId`, using its
      existing idempotency on `provider_payment_id`.

   d. Only when the mapped status is `CAPTURED`, transition the order to `PAID`
      with `expect: 'AWAITING_PAYMENT'` and patch `providerPaymentId`. A
      `PENDING` or `FAILED` payment must not confirm seats.

   e. **Confirm reservations whenever the order *is* `PAID` — never gated on
      whether the transition just changed it.** Re-read the order's status after
      step (d) and, if it is `PAID`, call `confirmReservation` for every
      occurrence line item carrying a `reservationId`.

      This distinction is the whole point. Gating on `changed === true` looks
      correct and is not: if the process dies after the order is marked `PAID`
      but before or partway through confirming seats, SQS redelivers, the
      transition reports `changed: false`, and the outstanding confirmations are
      skipped forever. The customer has paid and holds an unconfirmed seat that
      the expiry sweep will eventually cancel.

      Confirmation is individually idempotent, so re-running it for already
      confirmed seats is free. Skipping it is not.

   f. **Make the whole path re-runnable.** `recordPaymentFromWebhook` reports
      `created: false` on a repeat, `transitionOrder` returns `changed: false`
      when already `PAID`, and `confirmReservation` returns `changed: false`
      when already confirmed. A redelivered webhook — at any point in the
      sequence — must produce zero additional side effects and must still finish
      any work the previous attempt left undone.

5. **Handle the expired-hold case.** If `confirmReservation` throws
   `InvalidReservationTransitionError` because the hold was already expired and
   cancelled, the customer has paid for a seat that may have been resold.

   Do **not** silently swallow this, and do not re-hold the seat — the seat may
   genuinely be gone, and a second hold could oversell. Log at error level with
   the order id and reservation id, leave the order `PAID`, and let the payment
   stand for staff resolution. Enqueue a notification through the existing
   outbox so the situation is visible rather than buried in logs.

   This is the "money taken without a seat" risk from the program's register.
   The mitigation is that it is loud and recorded, not that it cannot happen.

6. **Preserve batch-failure semantics.** Keep the per-record try/catch and
   `batchItemFailures`, so one poisoned message does not fail the batch. Only
   genuine processing failures — not unknown event types, not unmatched orders —
   should be reported as failures.

7. **Do not re-derive trust in the consumer.** The existing comment is explicit
   that the envelope was verified at the HTTP boundary and the consumer must
   only validate shape. Preserve it.

8. **Run all four scripts** and `pnpm -r typecheck`.

## Tests

Vitest with `@keki/commerce-core` and `@keki/reservation-core` mocked; signature
tests use real HMAC vectors.

1. **Valid signature is accepted and enqueued** — Assert 200 and one SQS send.
2. **Invalid signature returns 401 and enqueues nothing** — Assert no SQS call.
3. **Missing signature header returns 401.**
4. **Verification uses the notification URL** — Sign for URL A, configure URL B;
   assert 401. This proves the real verifier is wired in, not the old one.
5. **Missing `SQUARE_NOTIFICATION_URL` throws at startup** — Assert the
   configuration error, matching existing getter behavior.
6. **The Phase 1 verifier is gone** — Assert `src/verify-signature.ts` no longer
   exists and nothing imports it.
7. **`payment.updated` with `CAPTURED` marks the order `PAID`** — Assert the
   transition and the payment record. **This is SC-06.**
8. **Order is resolved by Square order id, not payload fields** — Supply a
   payload containing a bogus `household_id`; assert it is ignored and the
   household comes from our order row.
9. **A pending payment does not mark the order paid** — Assert no transition.
10. **A failed payment does not confirm reservations** — Assert
    `confirmReservation` was not called.
11. **Paid orders confirm every occurrence line's reservation** — Two class
    lines; assert two confirmations. **This is SC-07.**
12. **Cafe-only orders confirm nothing** — Assert no reservation calls and a
    successful `PAID`.
13. **Replaying the same webhook changes nothing** — Process twice; assert one
    payment record, one transition, and confirmations reporting
    `changed: false` on the second pass. **This is SC-13's replay half.**
13a. **A crash after `PAID` still confirms the seats on retry** — Make
    `confirmReservation` throw on the first attempt *after* the order has
    transitioned to `PAID`, then re-deliver the message. Assert the second pass
    confirms every outstanding reservation despite `transitionOrder` reporting
    `changed: false`. **This is SC-13's resume half, and the test that fails an
    implementation gating confirmation on `changed`.**
13b. **A partial confirmation completes on retry** — Two class lines; fail the
    second confirmation on the first attempt. Assert that after redelivery both
    reservations are `CONFIRMED` and the first was not double-confirmed.
14. **An unmatched Square order acknowledges without failing** — Assert no batch
    failure and a warning log.
15. **An expired hold is logged and does not fail the message** — Make
    `confirmReservation` throw the transition error; assert an error log, an
    outbox enqueue, the order still `PAID`, and no batch failure.
16. **An expired hold is never silently re-held** — Assert `holdReservation` was
    not called.
17. **`catalog.version.updated` enqueues a catalog sync** — Assert the
    scheduled-task message. **This is SC-12's webhook half.**
18. **Unknown event types acknowledge without failing** — Assert no batch
    failure and no DLQ pressure.
19. **A genuine processing failure is reported** — Make the database throw;
    assert the message id appears in `batchItemFailures`.
20. **One bad record does not fail its batch** — Two records, one malformed;
    assert only the malformed id is reported.

## Acceptance Criteria

1. `functions/square-webhook` passes all four scripts, and `pnpm -r typecheck`
   passes workspace-wide.
2. The HTTP handler verifies with `@keki/square-client` using the notification
   URL; the Phase 1 verifier file is deleted and unreferenced (tests 4, 6).
3. The placeholder payload schema and its `TODO(phase-2)` are gone; no
   `household_id` or `reservation_id` is read from the payload.
4. Order identity is resolved from our database via Square's echoed reference,
   never from payload fields (test 8).
5. Only a `CAPTURED` payment transitions an order to `PAID`.
6. Paid orders confirm every reservation their line items hold (SC-07).
7. Confirmation is driven by the order **being** `PAID`, never by the transition
   having changed it, so a crash at any point in the sequence completes on retry
   (tests 13a, 13b). **SC-13.**
8. Unmatched orders and unknown event types acknowledge rather than
   dead-lettering.
9. Expired holds on paid orders are logged loudly and surfaced through the
   outbox, never silently swallowed and never re-held (tests 15, 16).
10. `catalog.version.updated` triggers a catalog sync.
11. Per-record batch-failure semantics are preserved.
