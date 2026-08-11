# WS-05: commerce-core — order lifecycle, seat holding, and real startCheckout

## Goal

Turn a validated cart into a persisted order with **server-computed** amounts
and **held seats**, atomically, then hand that order to Square for checkout.
Replace the Phase 1 `startCheckout` stub with a real implementation.

Two rules govern this workstream:

1. **The client never supplies a price.** WS-01 made a client price
   unrepresentable; this is where amounts are actually derived from the catalog.
2. **An order and its seats are one act.** A paid order whose seats were never
   held, or held seats with no order, are both broken states that require manual
   repair. `createOrder` holds seats inside its own transaction through the
   injected `SeatHolder` port — it does not import `reservation-core`, which the
   package boundary forbids.

## Traceability

- **SC-04** — Submitting a cart with a tampered price or amount is rejected; the
  order is created from server-side amounts only.
- **SC-05** — Partially: implements the `createCheckout` call whose URL WS-13
  redirects to.
- **SC-18** — A participant from another household is rejected server-side.
- **SC-19** — Order creation and seat holding are atomic: neither a seatless paid
  order nor an orderless hold can result.
- **SC-03** — Partially: supplies the server-side subtotal the cart displays.

## Dependencies

- **WS-02** — Database (`orders`, `order_line_items`).
- **WS-03** — square-client (consumed by interface only).
- **WS-06** — reservation-core (supplies the `SeatHolder` implementation this
  package composes with; the port itself comes from WS-01).

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Integrations" and "Module boundaries"; a core depends on
  `contracts` and `database` only, never on another core or a vendor SDK
- `docs/vision.md` — "Core Concepts" (Household, Child) and "Scope: Phase 2+"
- `packages/commerce-core/src/commands.ts` — the `startCheckout` stub and its
  comment on why `SquareClient` arrives as a parameter
- `packages/commerce-core/src/record-payment.ts` — the existing idempotent upsert
- `packages/database/src/schema/orders.ts` — `orders`, `order_line_items`
- `packages/database/src/schema/catalog.ts` — `catalog_items`, `offerings`,
  `occurrences`
- `packages/database/src/schema/people.ts` — `customers` and `children`, both
  keyed by `household_id`; this is what makes SC-18 checkable
- `packages/contracts/src/catalog.ts` — `Cart`, `CartLine`, `CartParticipantRef`
- `packages/contracts/src/ports.ts` — `SeatHolder`, `TransactionScope`
- `packages/contracts/src/orders.ts` — `ORDER_TRANSITIONS`, `canTransition`
- `packages/contracts/src/integrations/square.ts` — the widened `SquareClient`

## Package

`packages/commerce-core`

## Files Touched

- `packages/commerce-core/src/orders.ts` (NEW) — `createOrder`, price resolution,
  participant validation
- `packages/commerce-core/src/order-state.ts` (NEW) — guarded transitions
- `packages/commerce-core/src/errors.ts` (NEW) — typed rejection errors
- `packages/commerce-core/src/commands.ts` (MODIFY) — real `startCheckout`
- `packages/commerce-core/src/queries.ts` (MODIFY) — order reads
- `packages/commerce-core/src/index.ts` (MODIFY) — barrel
- `packages/commerce-core/src/orders.test.ts` (NEW)
- `packages/commerce-core/src/order-state.test.ts` (NEW)
- `packages/commerce-core/src/commands.test.ts` (MODIFY)

## Existing Interfaces to Consume

The stub being replaced, whose comment establishes the dependency direction this
implementation preserves:

```ts
// TODO(phase-2): Square checkout, payment capture, and refunds land here.
// Every command below already takes a `SquareClient` so the dependency
// direction — commerce-core depends on the interface, never the Square SDK
// (see AGENTS.md "Integrations") — is visible in compiling code.

export function startCheckout(input: {
  squareClient: SquareClient;
  reservationId: ReservationId;   // becomes orderId in WS-01
  amountCents: number;
  currency: string;
}): Promise<{ checkoutUrl: string; providerPaymentId: string }> {
  return Promise.reject(new NotImplementedInPhase1('startCheckout'));
}
```

The idempotency pattern already proven in this package:

```ts
export declare function recordPaymentFromWebhook(input: {
  providerPaymentId: string;
  householdId: HouseholdId;
  amountCents: number;
  status: PaymentStatus;
  rawPayload: Record<string, unknown>;
  occurredAt: Date;
}): Promise<{ record: PaymentRecord; created: boolean }>;
```

The cart, which carries participants but no prices and no occurrence quantity:

```ts
export type CartParticipantRef =
  | { readonly kind: 'CUSTOMER'; readonly customerId: CustomerId }
  | { readonly kind: 'CHILD'; readonly childId: ChildId };

export type CartLine =
  | { kind: 'CATALOG_ITEM'; catalogItemId: CatalogItemId; quantity: number }
  | { kind: 'OCCURRENCE'; occurrenceId: OccurrenceId; participants: readonly CartParticipantRef[] };
```

The port that lets this package hold seats without importing `reservation-core`:

```ts
export interface SeatHolder {
  holdSeats(input: {
    readonly occurrenceId: OccurrenceId;
    readonly householdId: HouseholdId;
    readonly createdByCustomerId: CustomerId;
    readonly participants: readonly CartParticipantRef[];
    readonly holdTtlMinutes: number;
    readonly tx: TransactionScope;
  }): Promise<HeldSeat>;
}

export interface HeldSeat {
  readonly occurrenceId: OccurrenceId;
  readonly reservationId: ReservationId;
  readonly seatCount: number;
}
```

The transition table:

```ts
export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  DRAFT: ['AWAITING_PAYMENT', 'CANCELLED'],
  AWAITING_PAYMENT: ['PAID', 'CANCELLED', 'EXPIRED'],
  PAID: [], CANCELLED: [], EXPIRED: [],
} as const;
```

## Implementation Steps

1. **Add typed errors** in `errors.ts`: `CatalogItemNotFoundError`,
   `CatalogItemUnavailableError`, `OccurrenceNotBookableError`,
   `MixedCurrencyError`, `ParticipantNotInHouseholdError`,
   `InvalidOrderTransitionError`, `OrderNotFoundError`.

2. **Validate participants against the household** in `orders.ts`. This runs
   **before** any price resolution:

   ```ts
   async function assertParticipantsInHousehold(input: {
     householdId: HouseholdId;
     participants: readonly CartParticipantRef[];
     tx: TransactionScope;
   }): Promise<void>;
   ```

   For each ref, confirm the `customers` or `children` row exists **and** its
   `household_id` equals the session household. Throw
   `ParticipantNotInHouseholdError` otherwise.

   This is SC-18 and it is a privacy control, not a validation nicety. The
   participant ids arrive from the browser. Without this check, any signed-in
   customer who guesses or obtains another family's child id can book that child
   into a class — and the reservation, the check-in list, and eventually the
   waiver record would all name a child from a household that never consented.

   Do not rely on the picker only offering household members. The picker is UI;
   this is the boundary.

3. **Implement price resolution** — the heart of SC-04:

   ```ts
   interface ResolvedLine {
     readonly kind: OrderLineItemKind;
     readonly catalogItemId: CatalogItemId | null;
     readonly occurrenceId: OccurrenceId | null;
     readonly quantity: number;
     readonly unitPriceCents: number;
     readonly nameSnapshot: string;
     readonly currency: string;
     readonly participants: readonly CartParticipantRef[];
   }

   async function resolveCartLines(cart: Cart, tx: TransactionScope): Promise<readonly ResolvedLine[]>;
   ```

   For `CATALOG_ITEM`, read `price_cents`, `name`, and `currency` from the
   `catalog_items` row. For `OCCURRENCE`, join through to `offerings` and read
   them from the offering; set `quantity = participants.length`.

   The input contributes exactly two things: catalog quantity, and which people
   attend. Every monetary value comes from the database. Write that as a comment
   — it is the invariant a later editor must not break.

   Reject rather than silently dropping:

   - unknown catalog item → `CatalogItemNotFoundError`
   - `ARCHIVED` item → `CatalogItemUnavailableError`
   - offering unpublished, occurrence not `SCHEDULED`, or `starts_at` past →
     `OccurrenceNotBookableError`
   - resolved lines disagreeing on currency → `MixedCurrencyError`

   Dropping an unavailable line and charging for the rest would sell the
   customer something other than what they reviewed.

4. **Implement `createOrder`** — atomic across pricing, seats, and persistence:

   ```ts
   export async function createOrder(input: {
     cart: Cart;
     householdId: HouseholdId;
     createdByCustomerId: CustomerId;
     seatHolder: SeatHolder;
     holdTtlMinutes?: number; // default 15
     now?: Date;
   }): Promise<{ order: Order; lineItems: readonly OrderLineItem[] }>;
   ```

   Open **one** transaction and, inside it, in this order:

   a. Parse the cart through `cartSchema`, even if the caller claims it is
      validated. This function persists money and is reachable from more than
      one caller.
   b. Validate participants (step 2).
   c. Resolve lines and compute `subtotalCents` as the sum of
      `unitPriceCents * quantity`.
   d. Insert the `orders` row as `DRAFT` with `expiresAt = now + ttl`.
   e. For each occurrence line, call `seatHolder.holdSeats(..., { tx })` and keep
      the returned `reservationId`.
   f. Insert `order_line_items`, writing `reservationId` onto each occurrence
      line.

   **Everything shares the single `tx`.** That is what makes SC-19 true: a
   capacity rejection at step (e) rolls back the order from (d), and a failure at
   (f) releases the holds from (e). Passing a fresh connection to `holdSeats`
   would silently break atomicity while every test still passed — which is why
   test 20 asserts the handle is the same one.

   Let `CapacityExceededError` from the seat holder propagate unchanged. WS-07
   maps it to `CONFLICT`; wrapping it here would lose the occurrence id the UI
   needs to tell the customer which class sold out.

   `subtotalCents` is our arithmetic for display and reconciliation, **not** the
   charge amount — Square computes that including tax. Comment this at the
   assignment.

5. **Implement guarded transitions** in `order-state.ts`:

   ```ts
   export async function transitionOrder(input: {
     orderId: OrderId;
     to: OrderStatus;
     expect?: OrderStatus;
     patch?: Partial<Pick<Order, 'squareOrderId' | 'squareCheckoutUrl' | 'providerPaymentId'>>;
     now?: Date;
   }): Promise<{ order: Order; changed: boolean }>;
   ```

   Do the read and write as a single conditional
   `UPDATE ... WHERE id = $1 AND status = $2`, never read-then-write. A
   read-then-write races the payment webhook — a customer can pay while an
   expiry sweep cancels the same order.

   Consult `canTransition`; throw `InvalidOrderTransitionError` on an illegal
   edge. When the row is already in the target state, return `changed: false`
   rather than throwing — WS-10's webhook is SQS-retried and must re-run
   harmlessly.

6. **Implement the real `startCheckout`** in `commands.ts`:

   ```ts
   export async function startCheckout(input: {
     squareClient: SquareClient;
     orderId: OrderId;
     redirectUrl: string;
   }): Promise<{ checkoutUrl: string; squareOrderId: string }>;
   ```

   a. Load the order and line items; reject unless `DRAFT` or `AWAITING_PAYMENT`.
   b. **If `squareCheckoutUrl` is already set, return it** without calling
      Square. This is the double-submit mitigation: a double-click must reach the
      same payment link, not two.
   c. Call `createCheckout` with line items built from the **persisted** rows,
      never from caller input. The persisted rows are what the customer reviewed.
   d. Use the order id as `idempotencyKey`.
   e. Transition `DRAFT → AWAITING_PAYMENT`, patching `squareOrderId` and
      `squareCheckoutUrl`.
   f. Let `SquareApiError` propagate; leave the order `DRAFT` so a retry can
      succeed. Do not mark it failed on a transient outage.

7. **Add order queries** in `queries.ts`: `getOrderById`,
   `getOrderWithLineItems`, `getOrderBySquareOrderId` (WS-10 resolves orders from
   Square's echoed reference), and `listOrdersForHousehold`.

8. **Leave `capturePayment` and `refundPayment` as stubs.** `PAID` is terminal;
   refunds are out of scope.

9. **Run all four scripts** and `pnpm -r typecheck`.

## Tests

Database tests are `describe.skipIf(!hasLiveDatabase)`; Square and the seat
holder are stubs, except where a real one is required.

1. **`createOrder` computes the subtotal from the database** — Seed a 500¢ item
   at quantity 2; assert `subtotalCents === 1000`.
2. **A tampered price is ignored** — Submit a line carrying `unitPriceCents: 1`;
   assert schema rejection and no order. **SC-04's primary assertion.**
3. **Line items snapshot the catalog price** — Assert values come from the row,
   then change the catalog price and assert the persisted line item is unchanged.
4. **Occurrence quantity derives from participants** — Two participants; assert
   `quantity === 2` with no client-supplied number.
5. **A child from another household is rejected** — Assert
   `ParticipantNotInHouseholdError` and no order. **This is SC-18.**
6. **A customer from another household is rejected** — Same, for the customer
   branch.
7. **A non-existent participant is rejected** — Assert the same error rather than
   a foreign-key crash.
8. **Participant validation precedes pricing** — Submit a cart with both a
   foreign child and an archived item; assert the participant error, proving
   ordering.
9. **Archived catalog item is rejected** — `CatalogItemUnavailableError`, no
   partial order.
10. **Unknown catalog item is rejected** — `CatalogItemNotFoundError`.
11. **Unpublished offering is rejected** — `OccurrenceNotBookableError`.
12. **Past occurrence is rejected** — Same error.
13. **Mixed currencies are rejected** — `MixedCurrencyError`.
14. **`reservationId` is written onto occurrence line items** — Assert each
    occurrence line carries the id returned by the seat holder. Without this,
    WS-10 can never confirm the seat.
15. **Cafe-only orders hold no seats** — Assert `holdSeats` was not called.
16. **Capacity rejection rolls back the whole order** _(integration)_ — Use the
    **real** `reservation-core` seat holder against a full occurrence; assert
    `CapacityExceededError`, no `orders` row, and no `order_line_items` row.
    **This is SC-19's first half.**
17. **A line-item failure releases the holds** _(integration)_ — Force the line
    item insert to fail after seats are held; assert no reservation row survives.
    **This is SC-19's second half.**
18. **`CapacityExceededError` propagates unwrapped** — Assert the error type and
    that it still carries `occurrenceId`.
19. **A partially-filled class rejects only the overflow** — Capacity 3 with 2
    taken, order 2 seats; assert rejection and full rollback, not a partial
    booking of one seat.
20. **The seat holder receives the order's transaction handle** _(integration)_ —
    Assert the `tx` passed to `holdSeats` is the same handle the order insert
    used. This is the test that catches an implementation that opens a second
    connection and silently loses atomicity.
21. **`transitionOrder` permits a legal edge** — `DRAFT → AWAITING_PAYMENT`,
    `changed: true`.
22. **`transitionOrder` rejects an illegal edge** — `DRAFT → PAID` throws.
23. **`transitionOrder` is idempotent on a repeat** — Returns `changed: false`
    without throwing. WS-10 depends on this.
24. **`transitionOrder` detects a concurrent change** — Assert a mismatched
    `expect` fails rather than overwriting.
25. **`PAID` is terminal** — `PAID → CANCELLED` throws.
26. **`startCheckout` calls Square once and stores the URL** — Assert one call,
    `squareCheckoutUrl` set, status `AWAITING_PAYMENT`.
27. **`startCheckout` is idempotent** — Call twice; assert Square called once and
    both return the same URL.
28. **`startCheckout` uses persisted line items** — Assert the stub's input
    matches the database rows, not the cart.
29. **`startCheckout` passes the order id as the idempotency key.**
30. **A Square outage leaves the order retryable** — Assert status stays `DRAFT`
    with no checkout URL.
31. **`startCheckout` rejects a paid order.**
32. **Remaining stubs still throw** — `capturePayment` and `refundPayment` reject
    with `NotImplementedInPhase1`.
33. **No forbidden dependencies** — Assert `package.json` declares no `square`,
    no `@keki/square-client`, and **no `@keki/reservation-core`**.

## Acceptance Criteria

1. `packages/commerce-core` passes all four scripts, and `pnpm -r typecheck`
   passes workspace-wide.
2. Every monetary amount is derived from `catalog_items` or `offerings`; the only
   client-supplied values are catalog quantity and participant identity
   (tests 1–4).
3. Every participant is verified to belong to the session household **before**
   pricing, and a foreign participant is rejected (tests 5–8). **SC-18.**
4. `createOrder` performs pricing, participant validation, seat holding, and both
   inserts inside **one** transaction, and the seat holder receives that
   transaction's handle (tests 16, 17, 20). **SC-19.**
5. Each occurrence line item carries the `reservationId` its hold produced
   (test 14).
6. `commerce-core` holds seats through the injected `SeatHolder` port and does
   **not** depend on `@keki/reservation-core` (test 33).
7. `CapacityExceededError` propagates unwrapped with its occurrence id.
8. Unavailable, unknown, unpublished, past, and mixed-currency lines are rejected
   with typed errors, never silently dropped.
9. Line items snapshot `unitPriceCents` and `nameSnapshot` at order time.
10. `transitionOrder` uses a single conditional UPDATE, honours
    `ORDER_TRANSITIONS`, and returns `changed: false` on a repeat.
11. `startCheckout` returns an existing checkout URL rather than creating a
    second Square link (test 27), builds line items from persisted rows, and
    leaves the order retryable on a Square failure.
12. `capturePayment` and `refundPayment` remain unimplemented.
