# WS-13: Checkout action, Square composition root, and order status page

## Goal

Complete the purchase path: convert the reviewed cart into an order with held
seats, redirect the customer to Square-hosted checkout, and show them an order
status page when they return.

This workstream also establishes the **single composition root** for the web
app — the one server-only module that constructs the production `SquareClient`
and `SeatHolder`. Without it, checkout has no defined way to reach Square in
production, and every future surface would invent its own wiring.

## Traceability

- **SC-05** — Checkout redirects to a Square-hosted payment page for the created
  order.
- **SC-04** — Partially: the checkout action passes no amounts to `createOrder`.
- **SC-19** — Partially: the action is the caller that makes order creation and
  seat holding one act.

## Dependencies

- **WS-05** — commerce-core (`createOrder`, `startCheckout`).
- **WS-09** — Cart and participant selection (the reviewed cart this consumes).

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Integrations" and "Module boundaries"; only the composition
  root wires a concrete vendor client
- `docs/vision.md` — "Target Users"; the customer surface
- `apps/web/app/actions/authenticated-action.ts` — the WS-07 wrapper
- `apps/web/app/actions/errors.ts` — domain-error → envelope mapping
- `apps/web/app/(customer)/cart/cart-cookie.ts` — `readCart`, `clearCart`
- `apps/web/app/(customer)/cart/page.tsx` — the review page this extends
- `packages/commerce-core/src/orders.ts` — `createOrder`
- `packages/commerce-core/src/commands.ts` — `startCheckout`
- `packages/commerce-core/src/queries.ts` — `getOrderWithLineItems`
- `packages/square-client/src/client.ts` — `createSquareClient`
- `packages/reservation-core/src/seat-holder.ts` — `createSeatHolder`
- `apps/web/app/auth/guards.ts` — `sanitizeNextPath`, whose open-redirect
  reasoning applies to the Square return URL

## Package

`apps/web` and `packages/ui`

## Files Touched

- `apps/web/app/server-clients.ts` (NEW) — the composition root
- `apps/web/app/(customer)/cart/checkout-action.ts` (NEW) — the checkout action
- `apps/web/app/(customer)/cart/checkout-button.tsx` (NEW) — client island
- `apps/web/app/(customer)/cart/page.tsx` (MODIFY) — mount the checkout control
- `apps/web/app/(customer)/orders/[orderId]/page.tsx` (NEW) — status page
- `apps/web/app/server-clients.test.ts` (NEW)
- `apps/web/app/(customer)/cart/checkout-action.test.ts` (NEW)
- `apps/web/app/(customer)/orders/[orderId]/page.test.tsx` (NEW)
- `packages/ui/src/components/order-summary.tsx` (NEW)
- `packages/ui/src/components/index.ts` (MODIFY)

## Existing Interfaces to Consume

The commerce entry points from WS-05. `createOrder` takes the seat holder and
holds seats inside its own transaction — the action does not hold seats itself:

```ts
export declare function createOrder(input: {
  cart: Cart;
  householdId: HouseholdId;
  createdByCustomerId: CustomerId;
  seatHolder: SeatHolder;
  holdTtlMinutes?: number;
  now?: Date;
}): Promise<{ order: Order; lineItems: readonly OrderLineItem[] }>;

export declare function startCheckout(input: {
  squareClient: SquareClient;
  orderId: OrderId;
  redirectUrl: string;
}): Promise<{ checkoutUrl: string; squareOrderId: string }>;
```

The concrete constructors this module wires — the only place in `apps/web` that
may call them:

```ts
export declare function createSquareClient(config?: Partial<SquareConfig>): SquareClient;
export declare function createSeatHolder(): SeatHolder;
```

The WS-07 wrapper and envelope:

```ts
export function authenticatedAction<TInput, TOutput>(config: {
  schema: z.ZodType<TInput>;
  requiredRole?: Role;
  handler: (input: TInput, session: Session) => Promise<TOutput>;
}): (raw: unknown) => Promise<ActionResult<TOutput>>;
```

The open-redirect guard whose reasoning applies to the Square return URL:

```ts
/**
 * Accepts only same-origin relative paths, so the `next` query parameter can
 * never bounce a signed-in user to an attacker-controlled host.
 */
export function sanitizeNextPath(candidate: string | null | undefined): string;
```

## Implementation Steps

1. **Build the composition root** in `apps/web/app/server-clients.ts`:

   ```ts
   import 'server-only';

   export function getSquareClient(): SquareClient;
   export function getSeatHolder(): SeatHolder;
   ```

   Mark the module `server-only` so importing it from a client component is a
   build error. It reads `SQUARE_ACCESS_TOKEN` and constructs the real client;
   that token must never reach a browser bundle, and `server-only` is what makes
   that a compile-time guarantee rather than a review convention.

   Memoize both per process. Constructing a fresh SDK client on every request
   discards connection reuse and multiplies cold-start cost.

   **This is the only module in `apps/web` permitted to import
   `@keki/square-client` or `@keki/reservation-core`'s `createSeatHolder`.** Every
   other module receives them as parameters. Assert this with a boundary test —
   without it, the next feature imports the SDK directly and the indirection this
   program built becomes decorative.

   When a stub flag is set outside production, return
   `createStubSquareClient()` instead, so WS-12's Playwright run never contacts
   Square. Follow the `createNoopProviders` precedent: refuse the stub when
   `NODE_ENV === 'production'`.

2. **Implement `checkoutAction`** in `checkout-action.ts`, wrapped in
   `authenticatedAction` with an empty input schema:

   a. Read the cart from the cookie; reject an empty cart with `VALIDATION`. The
      cookie is the state — do not accept a cart from the request body.

   b. Call `createOrder` with the session's `householdId` and
      `createdByCustomerId`, and `getSeatHolder()`. **Pass no amounts.** WS-05
      recomputes everything and holds every class seat in the same transaction.

   c. Call `startCheckout` with `getSquareClient()` and a `redirectUrl` of
      `{APP_BASE_URL}/orders/{orderId}`.

      Build the base URL from server configuration, never from a request header.
      A `Host`-derived redirect is attacker-controllable and would send a paying
      customer to another origin after checkout — the same class of bug
      `sanitizeNextPath` exists to prevent.

   d. Clear the cart **only after** `startCheckout` succeeds. Clearing first
      loses the customer's cart on a Square outage, along with their participant
      selections.

   e. Return `{ checkoutUrl }`; the client island navigates.

   Let domain errors propagate to the WS-07 mapper: `CapacityExceededError` →
   `CONFLICT` ("that class just sold out"), `ParticipantNotInHouseholdError` →
   `CONFLICT`, `SquareApiError` → `UNAVAILABLE`.

3. **Build the checkout island** in `checkout-button.tsx`: `'use client'`, calls
   the action, renders the error message on failure, and disables while pending
   via `useTransition`.

   Disabling while pending is the first defense against double-submit; WS-05's
   idempotent `startCheckout` is the real one, because a determined double-click
   still gets through.

4. **Mount the control** on the review page, disabled when any line resolved as
   unavailable.

5. **Build the order status page** at `/orders/[orderId]`. Load the order with
   its line items and render by status:

   - `PAID` → confirmation with line items and named class participants
   - `AWAITING_PAYMENT` → "payment is processing", since the webhook may not have
     landed yet
   - `DRAFT` → "checkout not completed", with a link back to `/cart`
   - `CANCELLED` / `EXPIRED` → explanation and a link to `/book`

   **Do not transition the order here.** A customer returning from Square is not
   proof of payment — anyone can visit the URL, and the redirect fires whether or
   not the charge succeeded. Only WS-10's signed webhook may set `PAID`.

   Authorize the order against the session household and return 404 for another
   household's order. Order ids are uuids, but object-level authorization is not
   optional.

   Render `AWAITING_PAYMENT` as a calm processing state that refreshes, not an
   error. Webhook delivery is normally seconds behind the redirect, so this is
   the expected first view for most successful purchases.

6. **Add `OrderSummary`** to `@keki/ui`: line items, participant names, subtotal,
   and status. Presentational only.

7. **Run all four scripts** for both packages.

## Tests

Vitest with `@keki/commerce-core`, `@keki/square-client`, and
`@keki/reservation-core` mocked at the module boundary.

1. **`getSquareClient` returns a client and memoizes** — Assert two calls return
   the same instance.
2. **`getSeatHolder` memoizes** — Same assertion.
3. **The composition root is server-only** — Assert the module imports
   `server-only`.
4. **No other web module imports the Square SDK or `createSeatHolder`** — Scan
   `apps/web` sources; assert `server-clients.ts` is the sole importer. This is
   what keeps the indirection real.
5. **The stub is refused in production** — Set the stub flag with
   `NODE_ENV=production`; assert it throws rather than returning a stub.
6. **The stub is used when flagged outside production** — Assert a stub instance.
7. **`checkoutAction` requires authentication** — Anonymous call returns
   `UNAUTHENTICATED` and creates no order.
8. **`checkoutAction` rejects an empty cart** — Assert `VALIDATION`.
9. **`checkoutAction` ignores a cart supplied in the payload** — Pass a body cart
   differing from the cookie; assert the cookie's cart was used.
10. **`checkoutAction` passes no amounts to `createOrder`** — Assert the mock
    received only cart, identity fields, and the seat holder. **SC-04's
    action-level assertion.**
11. **`checkoutAction` passes the real seat holder** — Assert `createOrder`
    received the instance from the composition root, so seats are actually held.
12. **The action does not hold seats itself** — Assert `holdReservation` was
    never called directly, proving atomicity lives in `createOrder`.
13. **A sold-out class surfaces as `CONFLICT`** — Make `createOrder` throw
    `CapacityExceededError`; assert the mapped code and a readable message.
14. **A foreign participant surfaces as `CONFLICT`** — Assert the mapped code.
15. **`checkoutAction` returns Square's URL** — Assert `checkoutUrl` comes from
    the stub. **This is SC-05.**
16. **The redirect URL is server-derived** — Set a hostile `Host` header; assert
    the redirect uses the configured base URL.
17. **The redirect URL targets the order status page** — Assert it ends with
    `/orders/{orderId}`.
18. **The cart is cleared only on success** — Assert the cookie survives a
    `startCheckout` failure and is cleared on success.
19. **A Square outage returns `UNAVAILABLE`** — Assert the mapped code and an
    intact cart, so the customer can retry without rebuilding their selections.
20. **Status page shows confirmation for `PAID`** — Assert line items and
    participant names render.
21. **Status page shows processing for `AWAITING_PAYMENT`** — Assert the
    processing state, not an error.
22. **Status page shows an incomplete state for `DRAFT`.**
23. **Status page never transitions the order** — Assert no transition function
    was called while rendering. **Payment state comes only from WS-10.**
24. **Status page 404s for another household's order** — Assert not-found.
25. **Status page 404s for an unknown order id.**

## Acceptance Criteria

1. `apps/web` and `packages/ui` pass all four scripts.
2. `apps/web/app/server-clients.ts` is the single composition root, marked
   `server-only`, memoized, and the only web module importing
   `@keki/square-client` or `createSeatHolder` (tests 3, 4).
3. The Square stub is available outside production and refused within it
   (tests 5, 6).
4. `checkoutAction` goes through `authenticatedAction`, reads the cart from the
   cookie only, and passes no amounts to `createOrder` (tests 8–10).
5. The action delegates seat holding to `createOrder` rather than holding seats
   itself (tests 11, 12).
6. Capacity and participant failures surface as `CONFLICT`; Square failures as
   `UNAVAILABLE`, with the cart intact for retry (tests 13, 14, 19).
7. The Square redirect URL is built from server configuration and targets the
   order status page (tests 16, 17). **SC-05.**
8. The cart is cleared only after `startCheckout` succeeds (test 18).
9. The status page renders all five order states, never transitions an order
   (test 23), and enforces household-level authorization (tests 24, 25).
10. `AWAITING_PAYMENT` renders as an expected processing state rather than a
    failure.
