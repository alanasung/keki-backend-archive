# WS-03: square-client — production Square adapter and signature verification

## Goal

Create `@keki/square-client`, the first and only production implementation of
the `SquareClient` interface. It wraps the Square SDK for catalog reads,
checkout creation, payment retrieval, and refunds, and it implements **Square's
real webhook signature scheme**, replacing the Phase 1 generic HMAC that
`docs/as-built.md` lists as tech debt.

This package exists separately because `AGENTS.md` forbids a core package from
depending on a vendor SDK. Domain code keeps depending on the interface in
`contracts`; only the composition root wires this concrete client.

The signature work is the security-critical half. WS-11 makes the webhook
Function URL publicly reachable, and that change is safe only if this
workstream is correct.

## Traceability

- **SC-10** — Webhook signature verification implements Square's
  notification-URL-plus-body scheme and rejects a forged signature.
- **SC-05** — Partially: supplies the `createCheckout` implementation WS-09's
  redirect depends on.
- **SC-12** — Partially: supplies the paginated `listCatalogItems` that WS-04's
  sync consumes.

## Dependencies

- **WS-01** — Contracts (the widened `SquareClient` interface this implements).

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Integrations" and "Module boundaries"; only this package may
  import the Square SDK
- `docs/vision.md` — "API Surface"; typed integration clients
- `docs/as-built.md` — "Known Limitations", the generic-HMAC entry this
  workstream closes
- `packages/contracts/src/integrations/square.ts` — the interface to implement
  (as widened by WS-01)
- `functions/square-webhook/src/verify-signature.ts` — the Phase 1
  implementation being replaced, including its constant-time comparison, which
  is correct and must be preserved
- `packages/auth/src/verify-token.ts` — precedent for refusing test overrides
  when `NODE_ENV === 'production'`
- `packages/notification-core/src/providers.ts` — precedent for a no-op/stub
  implementation that refuses to run in production

## Package

`packages/square-client` (NEW)

## Files Touched

- `packages/square-client/package.json` (NEW)
- `packages/square-client/tsconfig.json` (NEW)
- `packages/square-client/src/index.ts` (NEW)
- `packages/square-client/src/client.ts` (NEW) — `createSquareClient` factory
- `packages/square-client/src/catalog.ts` (NEW) — paginated catalog reads
- `packages/square-client/src/checkout.ts` (NEW) — payment link creation
- `packages/square-client/src/payments.ts` (NEW) — retrieval and refunds
- `packages/square-client/src/verify-signature.ts` (NEW) — Square's real scheme
- `packages/square-client/src/env.ts` (NEW) — credential resolution and guards
- `packages/square-client/src/stub.ts` (NEW) — `createStubSquareClient` for tests
- `packages/square-client/src/verify-signature.test.ts` (NEW)
- `packages/square-client/src/catalog.test.ts` (NEW)
- `packages/square-client/src/checkout.test.ts` (NEW)
- `packages/square-client/src/env.test.ts` (NEW)
- `packages/square-client/src/package-boundaries.test.ts` (NEW)

## Existing Interfaces to Consume

The interface to implement exactly, as widened by WS-01:

```ts
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

The Phase 1 verifier. Its `TODO` states precisely what is wrong, and its
length-guard-then-`timingSafeEqual` sequence is correct and must be carried
forward:

```ts
// TODO(phase-2): This is generic HMAC-SHA256 verification over the raw body,
// NOT Square's actual webhook scheme — Square signs the concatenation of the
// notification URL and the raw body, then base64-encodes the HMAC.
export function verifyWebhookSignature(input: {
  rawBody: string;
  signature: string;
  signingKey: string;
}): boolean {
  const expected = createHmac('sha256', input.signingKey).update(input.rawBody, 'utf8').digest();
  const provided = Buffer.from(input.signature, 'base64');

  // `timingSafeEqual` throws on a length mismatch, so this guard must run
  // first. Never fall back to `===`, which leaks the position of the first
  // mismatching byte through response timing.
  if (expected.length !== provided.length) {
    return false;
  }

  return timingSafeEqual(expected, provided);
}
```

The production-refusal precedent from `@keki/auth`, which this package mirrors
for credential mode:

```ts
// COGNITO_ISSUER / COGNITO_JWKS_URI overrides are refused when
// NODE_ENV === 'production'.
```

## Implementation Steps

1. **Scaffold the package** per the WS-01 workspace convention: `main`, `types`,
   and `exports` all point at `./src/index.ts`; `build` is `tsc --noEmit`; all
   four scripts defined. Depends on `@keki/contracts` and the `square` SDK
   only — **never** on `@keki/database` or any `*-core` package. This package
   translates between Square and our contracts; it must not reach into the
   database.

2. **Resolve credentials** in `env.ts`:

   ```ts
   export interface SquareConfig {
     readonly accessToken: string;
     readonly environment: 'sandbox' | 'production';
     readonly webhookSignatureKey: string;
     readonly notificationUrl: string;
   }

   export function resolveSquareConfig(env?: NodeJS.ProcessEnv): SquareConfig;
   ```

   Read `SQUARE_ACCESS_TOKEN`, `SQUARE_ENVIRONMENT`,
   `SQUARE_WEBHOOK_SIGNATURE_KEY`, and `SQUARE_NOTIFICATION_URL`. Validate
   eagerly and throw a typed `SquareConfigError` naming the missing variable,
   following how `packages/database/src/env.ts` validates at module load.

   **Guard the credential mode.** When `NODE_ENV === 'production'` and
   `SQUARE_ENVIRONMENT` is `sandbox`, throw. This is the named mitigation for
   the transposed-credentials risk: silently running production against sandbox
   means customers appear to pay and no money moves. Mirror the
   `packages/auth` refusal pattern.

3. **Implement `verify-signature.ts` — Square's real scheme.** This is the
   security-critical function in the program:

   ```ts
   export function verifySquareSignature(input: {
     rawBody: string;
     signature: string;
     signingKey: string;
     notificationUrl: string;
   }): boolean;
   ```

   Compute `HMAC-SHA256(signingKey, notificationUrl + rawBody)` and
   base64-encode it, then compare against the provided signature.

   Requirements that are not negotiable:

   - **The concatenation order is URL first, then body.** Reversing it produces
     a verifier that rejects every genuine Square delivery.
   - **`rawBody` must be the exact bytes received**, before any JSON parse and
     re-serialize. Re-serializing changes key order and whitespace and breaks
     every signature. The existing `http.ts` already threads the raw body
     correctly — preserve that.
   - **Keep the length guard before `timingSafeEqual`.** It throws on a length
     mismatch, so the guard is required, and it is not itself a timing leak
     because signature length is not secret.
   - **Never fall back to `===`.** Carry the Phase 1 comment forward; it
     explains why.
   - **Remove the `TODO(phase-2)`** — this workstream is what closes it.

4. **Implement paginated catalog reads** in `catalog.ts`. Call Square's catalog
   list for `ITEM` objects and flatten each item's variations into one
   `SquareCatalogItem` per variation, carrying the parent item's name and
   description alongside the variation's own price.

   A variation with no price (Square permits variable pricing) must be
   **skipped, not defaulted to zero**. A zero-priced latte on the ordering page
   is worse than an absent one.

   Return Square's cursor verbatim as `cursor`, or `null` when exhausted. Do not
   loop internally — WS-04 owns the paging loop, so a partial failure is
   resumable rather than restarting from scratch.

5. **Implement `createCheckout`** in `checkout.ts` using Square's Payment Links
   API. Pass line items with name, quantity, and unit price; pass
   `idempotencyKey` straight through to Square; pass `redirectUrl` so Square
   returns the customer to our confirmation page.

   Set our `orderId` as reference/metadata on the Square order. **This is the
   link WS-10 needs.** `docs/as-built.md` records that Phase 1's consumer
   invented `household_id` and `reservation_id` fields a real Square payload
   does not carry; the reference id set here is what replaces that placeholder
   with something real.

   Return `{ checkoutUrl, squareOrderId }`. Do not fabricate a payment id — none
   exists until the customer pays.

6. **Implement `getPayment` and `refundPayment`** in `payments.ts`, mapping
   Square's payment status to our `PAYMENT_STATUSES`. Make the mapping a total
   function over Square's documented statuses with an explicit `default` that
   throws on an unrecognized value, rather than silently coercing to `FAILED` —
   a new Square status must surface as an error, not a wrong payment state.

7. **Assemble the client** in `client.ts`:

   ```ts
   export function createSquareClient(config?: Partial<SquareConfig>): SquareClient;
   ```

   Construct the SDK client once and return an object satisfying `SquareClient`.
   Wrap SDK errors in a typed `SquareApiError` carrying the operation name and
   Square's error category, so callers can distinguish a retryable outage from a
   permanent rejection.

8. **Provide a stub** in `stub.ts`: `createStubSquareClient(overrides?)`
   returning an in-memory `SquareClient` with deterministic values. WS-09's
   Playwright run and WS-12 depend on this — a Playwright suite must not call
   Square. Follow the `createNoopProviders` precedent and make it refuse to run
   when `NODE_ENV === 'production'` unless an explicit override flag is set.

9. **Verify against the Square sandbox.** Run one real round trip: list catalog
   items and create a payment link. Gate these tests on
   `SQUARE_ACCESS_TOKEN` being present, following the
   `describe.skipIf(!hasLiveDatabase)` convention already used for Neon.

10. **Run all four scripts**, then `pnpm -r typecheck` workspace-wide.

## Tests

Signature tests use fixed vectors and need no credentials. Catalog and checkout
tests use a mocked SDK, plus sandbox tests skipped when credentials are absent.

1. **Valid Square signature verifies** — Compute the expected signature over a
   fixed URL and body with a known key; assert `true`.
2. **Forged signature is rejected** — Alter one byte of the signature; assert
   `false`. This is SC-10's core assertion.
3. **Body tampering is rejected** — Keep the signature, alter the body; assert
   `false`.
4. **Notification URL is part of the MAC** — Verify a signature computed for
   URL A against URL B; assert `false`. This is the test that proves the Phase 1
   scheme was actually replaced: the old body-only implementation passes tests
   1–3 but **fails this one**.
5. **Concatenation order is URL-then-body** — Assert a signature computed as
   body-then-URL is rejected.
6. **Length mismatch returns false rather than throwing** — Pass a truncated
   base64 signature; assert `false` and no exception.
7. **Non-base64 signature returns false** — Assert garbage input does not throw.
8. **Empty body with valid signature verifies** — Square sends bodyless test
   pings.
9. **`listCatalogItems` flattens variations** — Mock one item with two
   variations; assert two results, each with the item's name and its own price.
10. **Variations without a price are skipped** — Assert a priceless variation is
    omitted, not zero-priced.
11. **`listCatalogItems` returns Square's cursor** — Assert the cursor is passed
    through and becomes `null` when Square omits it.
12. **`createCheckout` passes the idempotency key through** — Assert the SDK
    received the exact key.
13. **`createCheckout` sets our order id as the Square reference** — Assert the
    reference field carries `orderId`, since WS-10 resolves the order from it.
14. **`createCheckout` returns `squareOrderId`, not a payment id** — Assert the
    returned shape has no payment id field.
15. **Payment status mapping is total** — Assert each documented Square status
    maps to a `PAYMENT_STATUSES` member, and an unknown status throws.
16. **Config refuses sandbox credentials in production** — With
    `NODE_ENV=production` and `SQUARE_ENVIRONMENT=sandbox`, assert
    `resolveSquareConfig` throws.
17. **Config names the missing variable** — Assert the error message identifies
    which variable is absent.
18. **Stub client refuses production** — Assert `createStubSquareClient` throws
    under `NODE_ENV=production` without the override flag.
19. **No core package leaks in** — Assert `package.json` declares no
    `@keki/*-core` and no `@keki/database` dependency.
20. **Sandbox round trip** _(integration, skipped without credentials)_ — List
    catalog items and create a payment link; assert a usable `checkoutUrl`.

## Acceptance Criteria

1. `packages/square-client` passes all four scripts, and `pnpm -r typecheck`
   passes workspace-wide.
2. The package implements `SquareClient` from `@keki/contracts` in full.
3. Signature verification computes HMAC-SHA256 over **notification URL
   concatenated with the raw body**, base64-encoded, compared in constant time,
   and passes tests 1–8 — test 4 in particular.
4. The length guard precedes `timingSafeEqual`, and no `===` fallback exists.
5. The `TODO(phase-2)` about generic HMAC no longer describes shipped behavior.
6. `listCatalogItems` flattens variations, skips priceless ones, and exposes
   Square's cursor without looping internally.
7. `createCheckout` sets our `orderId` as the Square order reference and returns
   `squareOrderId` without inventing a payment id.
8. Square payment-status mapping is total and throws on unknown values.
9. `resolveSquareConfig` refuses sandbox credentials when
   `NODE_ENV === 'production'`.
10. `createStubSquareClient` exists for downstream tests and refuses production.
11. This package is the only workspace member depending on the Square SDK, and
    it depends on no core package or on `@keki/database`.
