# WS-01: Contracts — catalog, cart, and order types; SeatHolder; widened SquareClient

## Goal

Add the type and schema vocabulary this program needs — catalog items, carts,
orders, and order line items — and change three Phase 1 interfaces that encode
assumptions no longer true:

1. `SquareClient.createCheckout` requires a `reservationId`. A cafe order has no
   reservation. It becomes order-shaped, with line items.
2. `verifyWebhookSignature` takes only `rawBody` and `signature`. Square's real
   scheme signs the notification URL concatenated with the body, so the URL must
   be part of the input.
3. Nothing lets `commerce-core` hold a seat without importing `reservation-core`,
   which the package boundary forbids. This workstream defines the `SeatHolder`
   port that inverts that dependency.

A cart line for a class names **who occupies each seat**, not just how many.
`holdReservation` requires participant records, and a bare quantity cannot
produce a valid one.

Types and schemas only. No runtime behavior beyond schema definitions.

## Traceability

- **SC-04** — Partially: defines the cart schema that carries ids, participants,
  and quantities but no client-supplied prices.
- **SC-05** — Partially: defines the `createCheckout` shape WS-05 implements.
- **SC-10** — Partially: defines the signature-verification input carrying the
  notification URL Square's scheme requires.
- **SC-17** — Partially: defines the participant-carrying occurrence cart line
  that makes a named seat expressible.
- **SC-19** — Partially: defines the `SeatHolder` port and transaction handle
  that let order creation and seat holding be atomic.

## Dependencies

None. This is the root of the program.

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Integrations" and "Module boundaries"; a type crossing a
  package boundary belongs in `contracts`, and a core depends on an interface,
  never on another core or a vendor SDK
- `docs/vision.md` — "Core Concepts", especially Child ("a non-authenticating
  participant attached to a household; the subject of many reservations")
- `packages/contracts/src/ids.ts` — the branded-id factory pattern
- `packages/contracts/src/entities.ts` — existing entities and status arrays,
  including `ReservationParticipant`
- `packages/contracts/src/integrations/square.ts` — the `SquareClient` interface
- `packages/contracts/src/index.ts` — the barrel
- `packages/commerce-core/src/commands.ts` — the `startCheckout` stub consuming
  the old shape
- `packages/reservation-core/src/commands.ts` — `holdReservation`'s existing
  participant requirement, which the cart must be able to satisfy
- `functions/square-webhook/src/verify-signature.ts` — the Phase 1 generic HMAC

## Package

`packages/contracts`

## Files Touched

- `packages/contracts/src/ids.ts` (MODIFY) — add `CatalogItemId`, `OrderId`,
  `OrderLineItemId`
- `packages/contracts/src/entities.ts` (MODIFY) — catalog/order entities and
  status constant arrays
- `packages/contracts/src/catalog.ts` (NEW) — cart and catalog view types plus
  Zod schemas
- `packages/contracts/src/orders.ts` (NEW) — order schemas and the transition
  table
- `packages/contracts/src/ports.ts` (NEW) — `SeatHolder` and `TransactionScope`
- `packages/contracts/src/integrations/square.ts` (MODIFY) — widen `SquareClient`
- `packages/contracts/src/index.ts` (MODIFY) — export the new modules
- `packages/contracts/src/catalog.test.ts` (NEW)
- `packages/contracts/src/orders.test.ts` (NEW)
- `packages/contracts/src/ports.test.ts` (NEW)
- `packages/contracts/src/entities.test.ts` (MODIFY)

## Existing Interfaces to Consume

The branded-id factory. Every new id goes through it:

```ts
declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function makeIdFactory<B extends string>(brandName: B): (value: string) => Brand<string, B> {
  return (value: string): Brand<string, B> => {
    if (!UUID_V4_RE.test(value)) {
      throw new Error(`Invalid ${brandName}: "${value}" is not a valid UUID v4 string.`);
    }
    return value as Brand<string, B>;
  };
}

export type OccurrenceId = Brand<string, 'OccurrenceId'>;
export const createOccurrenceId = makeIdFactory<'OccurrenceId'>('OccurrenceId');
export type ChildId = Brand<string, 'ChildId'>;
export type CustomerId = Brand<string, 'CustomerId'>;
```

The current `SquareClient` — `createCheckout`'s mandatory `reservationId` is the
assumption this workstream removes:

```ts
export interface SquareClient {
  createCheckout(input: {
    reservationId: ReservationId;
    amountCents: number;
    currency: string;
    idempotencyKey: string;
  }): Promise<{ checkoutUrl: string; providerPaymentId: string }>;
  getPayment(input: { providerPaymentId: string }): Promise<PaymentRecord | null>;
  refundPayment(input: {
    providerPaymentId: string;
    amountCents: number;
    idempotencyKey: string;
  }): Promise<{ refundId: string }>;
  verifyWebhookSignature(input: { rawBody: string; signature: string }): Promise<boolean>;
}
```

`holdReservation`'s signature — the reason a cart line must carry participants,
not a quantity:

```ts
export function holdReservation(input: {
  occurrenceId: OccurrenceId;
  householdId: HouseholdId;
  participants: readonly ReservationParticipant[];
}): Promise<Reservation>;
```

The status-array convention the Drizzle enums in WS-02 consume:

```ts
export const OFFERING_TYPES = ['CLASS', 'ROOM', 'OPEN_PLAY'] as const;
export type OfferingType = (typeof OFFERING_TYPES)[number];
```

## Implementation Steps

1. **Add branded ids** in `ids.ts`: `CatalogItemId`, `OrderId`, and
   `OrderLineItemId` with their factories.

   `CatalogItemId` is our own uuid for a cached row, **not** Square's catalog
   object id. Square's id is a separate opaque string (`squareCatalogObjectId`);
   conflating them would make our primary key depend on a vendor's id format and
   break the uuid validation in the factory.

2. **Add status constant arrays** in `entities.ts`:

   ```ts
   export const ORDER_STATUSES = ['DRAFT', 'AWAITING_PAYMENT', 'PAID', 'CANCELLED', 'EXPIRED'] as const;
   export type OrderStatus = (typeof ORDER_STATUSES)[number];

   export const ORDER_LINE_ITEM_KINDS = ['CATALOG_ITEM', 'OCCURRENCE'] as const;
   export type OrderLineItemKind = (typeof ORDER_LINE_ITEM_KINDS)[number];

   export const CATALOG_ITEM_STATUSES = ['ACTIVE', 'ARCHIVED'] as const;
   export type CatalogItemStatus = (typeof CATALOG_ITEM_STATUSES)[number];
   ```

   `ARCHIVED` is the tombstone for an item removed from Square. Deleting the row
   would orphan the `order_line_items` referencing it, so removal is a status
   change, never a delete.

3. **Add entity interfaces** in `entities.ts`:

   ```ts
   export interface CatalogItem {
     id: CatalogItemId;
     squareCatalogObjectId: string;
     squareVariationId: string;
     name: string;
     description: string | null;
     priceCents: number;
     currency: string;
     status: CatalogItemStatus;
     syncedAt: Date;
     createdAt: Date;
     updatedAt: Date;
   }

   export interface Order {
     id: OrderId;
     householdId: HouseholdId;
     createdByCustomerId: CustomerId;
     status: OrderStatus;
     subtotalCents: number;
     currency: string;
     squareOrderId: string | null;
     squareCheckoutUrl: string | null;
     providerPaymentId: string | null;
     expiresAt: Date | null;
     createdAt: Date;
     updatedAt: Date;
   }

   export interface OrderLineItem {
     id: OrderLineItemId;
     orderId: OrderId;
     kind: OrderLineItemKind;
     catalogItemId: CatalogItemId | null;
     occurrenceId: OccurrenceId | null;
     reservationId: ReservationId | null;
     quantity: number;
     unitPriceCents: number;
     nameSnapshot: string;
   }
   ```

   `subtotalCents` is deliberately "subtotal", not "total". Square owns tax and
   computes the authoritative charge. A field named `totalCents` would invite
   someone to treat our number as the amount charged.

   `unitPriceCents` and `nameSnapshot` are captured at order time. Without them a
   later catalog sync would retroactively rewrite what a customer was charged.

4. **Define the cart in `catalog.ts`.** The occurrence variant carries
   participants; quantity is derived from them:

   ```ts
   export type CartParticipantRef =
     | { readonly kind: 'CUSTOMER'; readonly customerId: CustomerId }
     | { readonly kind: 'CHILD'; readonly childId: ChildId };

   export type CartLine =
     | { kind: 'CATALOG_ITEM'; catalogItemId: CatalogItemId; quantity: number }
     | { kind: 'OCCURRENCE'; occurrenceId: OccurrenceId; participants: readonly CartParticipantRef[] };

   export interface Cart {
     readonly lines: readonly CartLine[];
   }
   ```

   `CartParticipantRef` mirrors the customer-XOR-child discriminated union that
   `reservation_participants` already enforces with a `CHECK`. The type system
   and the database agree on this invariant; do not introduce a third shape.

   An occurrence line has **no `quantity` field at all**. Seat count is
   `participants.length`. Two sources for the same number would eventually
   disagree, and the resulting overbooking would be silent.

   **The cart carries no prices.** This is the single most important decision
   here. If a price can be submitted by the client, a customer sets what they
   pay. WS-05 recomputes every amount server-side; the schema must make a client
   price impossible to *express*, not merely ignored.

5. **Add the cart Zod schema** as a discriminated union on `kind`:

   - `CATALOG_ITEM`: `quantity` integer in `1..99`
   - `OCCURRENCE`: `participants` array, min 1, max 10, each a strict
     discriminated union on its own `kind`
   - Cart: `lines` array, min 1, max 50

   Apply `.strict()` to every variant. A permissive schema that silently drops
   an unexpected `unitPriceCents` is indistinguishable at runtime from one that
   accepts it, so future readers cannot tell the tamper protection is real.

   Reject duplicate participants within one occurrence line. The same child
   cannot occupy two seats in the same class, and permitting it would consume
   capacity that nobody can attend.

6. **Add catalog view types** in `catalog.ts`:

   ```ts
   export interface CafeItemView {
     catalogItemId: CatalogItemId;
     name: string;
     description: string | null;
     priceCents: number;
     currency: string;
   }

   export interface BookableOccurrenceView {
     occurrenceId: OccurrenceId;
     offeringId: OfferingId;
     name: string;
     description: string | null;
     startsAt: Date;
     endsAt: Date;
     priceCents: number;
     currency: string;
     capacity: number;
     /** Display only — stale on return. The WS-02 trigger is the real check. */
     seatsRemaining: number;
   }

   export interface HouseholdMemberView {
     ref: CartParticipantRef;
     displayName: string;
     dateOfBirth: Date | null;
   }
   ```

   `HouseholdMemberView` is what the WS-09 picker renders. Its `ref` is exactly
   the shape a cart line needs, so the UI never constructs participant refs by
   hand.

7. **Define the order state machine** in `orders.ts` as data:

   ```ts
   export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
     DRAFT: ['AWAITING_PAYMENT', 'CANCELLED'],
     AWAITING_PAYMENT: ['PAID', 'CANCELLED', 'EXPIRED'],
     PAID: [],
     CANCELLED: [],
     EXPIRED: [],
   } as const;

   export function canTransition(from: OrderStatus, to: OrderStatus): boolean;
   ```

   `PAID` is terminal. Refunds are out of scope, and modelling them now would
   let WS-05 write code for a flow nobody has designed.

8. **Define the `SeatHolder` port** in `ports.ts`. This is what lets
   `commerce-core` hold seats without importing `reservation-core`:

   ```ts
   /**
    * Opaque handle for an in-progress database transaction. Defined as unknown
    * so `contracts` needs no Drizzle dependency; the implementation narrows it.
    */
   export type TransactionScope = unknown;

   export interface HeldSeat {
     readonly occurrenceId: OccurrenceId;
     readonly reservationId: ReservationId;
     readonly seatCount: number;
   }

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
   ```

   The `tx` parameter is the point of the port. Without it the caller could not
   make order creation and seat holding atomic, and a crash between them would
   leave either a paid order with no seat or a held seat nobody paid for.

   This mirrors how `dispatchNotification` receives `NotificationProviders` and
   `startCheckout` receives `SquareClient` — dependency inversion is the
   established idiom here, not a new pattern.

9. **Widen `SquareClient`** in `integrations/square.ts`:

   ```ts
   export interface SquareCheckoutLineItem {
     readonly name: string;
     readonly quantity: number;
     readonly unitPriceCents: number;
   }

   export interface SquareClient {
     listCatalogItems(input?: { cursor?: string }): Promise<{
       items: readonly SquareCatalogItem[];
       cursor: string | null;
     }>;
     createCheckout(input: {
       orderId: OrderId;
       lineItems: readonly SquareCheckoutLineItem[];
       currency: string;
       idempotencyKey: string;
       redirectUrl: string;
     }): Promise<{ checkoutUrl: string; squareOrderId: string }>;
     getPayment(input: { providerPaymentId: string }): Promise<PaymentRecord | null>;
     refundPayment(input: {
       providerPaymentId: string;
       amountCents: number;
       idempotencyKey: string;
     }): Promise<{ refundId: string }>;
     verifyWebhookSignature(input: {
       rawBody: string;
       signature: string;
       notificationUrl: string;
     }): Promise<boolean>;
   }
   ```

   Two changes are breaking and deliberate:

   - `createCheckout` returns `squareOrderId`, not `providerPaymentId`. No
     payment exists at checkout-creation time — Square creates it when the
     customer pays, and its id arrives on the webhook. The Phase 1 shape claimed
     an id it could not produce.
   - `verifyWebhookSignature` gains `notificationUrl`. Square's HMAC covers the
     URL plus the body; without it, the same signed body replays against a
     different endpoint.

   Add `SquareCatalogItem` (`squareCatalogObjectId`, `squareVariationId`, `name`,
   `description`, `priceCents`, `currency`).

10. **Update the `startCheckout` stub** in `packages/commerce-core/src/commands.ts`
    so the workspace compiles: take `orderId`, keep rejecting with
    `NotImplementedInPhase1`. WS-05 replaces the body.

11. **Export from the barrel** and run all four scripts, then `pnpm -r typecheck`
    to confirm the widened interface has not broken a consumer.

## Tests

1. **New id factories reject non-uuid input** — Assert `createOrderId('abc')`
   throws and a valid uuid v4 round-trips.
2. **Cart schema rejects a client-supplied price** — Parse a catalog line
   containing `unitPriceCents`; assert failure. SC-04's schema-level half.
3. **Occurrence line rejects a `quantity` field** — Assert a line carrying both
   `participants` and `quantity` fails, proving seat count has one source.
4. **Occurrence line requires at least one participant** — Assert `[]` fails.
5. **Occurrence line caps participants** — Assert 11 fails, 10 passes.
6. **Participant ref is customer XOR child** — Assert a ref carrying both
   `customerId` and `childId` fails.
7. **Duplicate participants are rejected** — Assert the same `childId` twice in
   one occurrence line fails.
8. **The same child may appear on two different occurrence lines** — Assert this
   passes; a child can attend two different classes.
9. **Catalog quantity range is enforced** — Assert `0`, `-1`, `100`, `1.5` fail;
   `1` and `99` pass.
10. **Cart rejects empty and oversized** — Assert `{ lines: [] }` and 51 lines
    both fail.
11. **`canTransition` permits only declared edges** — Assert
    `DRAFT → AWAITING_PAYMENT` allowed, `DRAFT → PAID` not.
12. **Terminal statuses have no outbound transitions** — Assert `PAID`,
    `CANCELLED`, `EXPIRED` permit nothing.
13. **Transition table covers every status** — Assert
    `Object.keys(ORDER_TRANSITIONS)` equals `ORDER_STATUSES`.
14. **Status arrays are frozen `as const`** — Mirror existing `entities.test.ts`
    assertions for the three new arrays.
15. **`SeatHolder` requires a transaction scope** — Add a `@ts-expect-error` case
    asserting a `holdSeats` call omitting `tx` does not compile. This is what
    keeps atomicity from being optional.
16. **`HouseholdMemberView.ref` is assignable to a cart participant** — A
    type-level assertion that the picker's output feeds a cart line directly.
17. **Widened checkout shape is pinned** — A `@ts-expect-error` case asserting a
    `createCheckout` call passing `reservationId` no longer compiles.
18. **No vendor SDK in contracts** — Assert `package.json` declares no `square`
    dependency.

## Acceptance Criteria

1. `packages/contracts` passes all four scripts, and `pnpm -r typecheck` passes
   workspace-wide with the widened interface in place.
2. `CatalogItemId`, `OrderId`, and `OrderLineItemId` exist as branded ids, and
   `CatalogItemId` is distinct from Square's catalog object id.
3. The cart schema makes a client-supplied price **unrepresentable** (test 2)
   and parses strictly rather than stripping unknown keys.
4. An occurrence cart line carries participants and **no quantity field**; seat
   count derives from `participants.length` (test 3).
5. Participant refs are customer XOR child, deduplicated within a line, and
   capped (tests 4–8).
6. `ORDER_TRANSITIONS` covers every `ORDER_STATUSES` member, with `PAID`,
   `CANCELLED`, and `EXPIRED` terminal.
7. `SeatHolder` is defined in `contracts` with a required `tx` parameter, so
   `commerce-core` can hold seats atomically without importing
   `reservation-core` (test 15).
8. `SquareClient.createCheckout` takes an order id plus line items, returns
   `squareOrderId`, and no longer mentions `reservationId`.
9. `SquareClient.verifyWebhookSignature` accepts `notificationUrl`.
10. `SquareClient.listCatalogItems` exists with cursor pagination.
11. `commerce-core`'s `startCheckout` stub compiles against the new shape and
    still rejects with `NotImplementedInPhase1`.
12. `BookableOccurrenceView.seatsRemaining` is documented as display-only and
    not the capacity check.
13. No Square SDK dependency is added to `packages/contracts`.
