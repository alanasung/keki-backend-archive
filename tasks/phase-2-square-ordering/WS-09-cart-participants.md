# WS-09: Cart, participant selection, and review page

## Goal

Make the ordering page collect a purchase: add cafe items to a cart, assign
named household members to class seats, and review the whole thing with a
server-computed subtotal.

The cart lives in a signed HTTP-only cookie. No cart table, no session store,
and — critically — **no prices in the cookie**. Every amount shown is recomputed
server-side from the catalog on each render.

Checkout itself is WS-13. This workstream stops at the reviewed cart.

## Traceability

- **SC-03** — A signed-in customer can add cafe items and a class seat to a cart
  and see a correct recomputed total.
- **SC-04** — Partially: the cookie and action boundaries reject any
  client-supplied price.
- **SC-17** — Each class seat is assigned to a named household member.

## Dependencies

- **WS-05** — commerce-core (price resolution used by the review page).
- **WS-06** — reservation-core (seat availability for the picker).
- **WS-08** — Ordering page (the surface and the card footer slot).

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Auth" and "Data access"
- `docs/vision.md` — "Core Concepts" (Household, Child) and "Target Users"
- `apps/web/app/actions/authenticated-action.ts` — the WS-07 wrapper every
  action here must use
- `apps/web/app/actions/action-result.ts` — the `ActionResult` envelope
- `apps/web/app/(customer)/book/page.tsx` — the WS-08 page being extended
- `packages/ui/src/components/catalog-item-card.tsx` — the footer slot
- `packages/contracts/src/catalog.ts` — `Cart`, `CartLine`, `CartParticipantRef`,
  `HouseholdMemberView`, `cartSchema`
- `packages/customer-core/src/queries.ts` — `listHouseholdMembers`
- `packages/catalog-core/src/queries.ts` — catalog reads for the review page
- `apps/web/app/auth/guards.ts` — `requireRole` and the session shape

## Package

`apps/web` and `packages/ui`

## Files Touched

- `apps/web/app/(customer)/cart/cart-cookie.ts` (NEW) — signed cookie read/write
- `apps/web/app/(customer)/cart/actions.ts` (NEW) — cart Server Actions
- `apps/web/app/(customer)/cart/resolve-cart.ts` (NEW) — server-side cart view
- `apps/web/app/(customer)/cart/page.tsx` (NEW) — review page
- `apps/web/app/(customer)/book/add-to-cart-button.tsx` (NEW) — client island
- `apps/web/app/(customer)/book/participant-picker.tsx` (NEW) — client island
- `apps/web/app/(customer)/book/page.tsx` (MODIFY) — mount the footer controls
- `apps/web/app/(customer)/cart/cart-cookie.test.ts` (NEW)
- `apps/web/app/(customer)/cart/actions.test.ts` (NEW)
- `apps/web/app/(customer)/cart/page.test.tsx` (NEW)
- `packages/ui/src/components/cart-summary.tsx` (NEW)
- `packages/ui/src/components/participant-checklist.tsx` (NEW)
- `packages/ui/src/components/index.ts` (MODIFY)

## Existing Interfaces to Consume

The WS-07 wrapper. Every action here goes through it — none resolves a session
itself:

```ts
export function authenticatedAction<TInput, TOutput>(config: {
  schema: z.ZodType<TInput>;
  requiredRole?: Role; // default 'CUSTOMER'
  handler: (input: TInput, session: Session) => Promise<TOutput>;
}): (raw: unknown) => Promise<ActionResult<TOutput>>;

export type ActionResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: ActionError };
```

The cart shape. An occurrence line names people; it has no quantity field:

```ts
export type CartParticipantRef =
  | { readonly kind: 'CUSTOMER'; readonly customerId: CustomerId }
  | { readonly kind: 'CHILD'; readonly childId: ChildId };

export type CartLine =
  | { kind: 'CATALOG_ITEM'; catalogItemId: CatalogItemId; quantity: number }
  | { kind: 'OCCURRENCE'; occurrenceId: OccurrenceId; participants: readonly CartParticipantRef[] };

export interface HouseholdMemberView {
  ref: CartParticipantRef;
  displayName: string;
  dateOfBirth: Date | null;
}
```

The household read path, already real in Phase 1 — no new domain work is needed
for the picker:

```ts
export declare function listHouseholdMembers(
  householdId: HouseholdId,
): Promise<readonly HouseholdMember[]>;
```

## Implementation Steps

1. **Implement the cart cookie** in `cart-cookie.ts`:

   ```ts
   export async function readCart(): Promise<Cart>;
   export async function writeCart(cart: Cart): Promise<void>;
   export async function clearCart(): Promise<void>;
   ```

   Serialize as JSON and append an HMAC-SHA256 signature keyed on
   `CART_COOKIE_SECRET`. On read, verify in constant time before parsing, then
   parse through `cartSchema`. A cookie failing either check returns an **empty
   cart** rather than throwing — a tampered or corrupted cookie must not
   hard-fail a page render.

   Set `httpOnly`, `secure` outside development, `sameSite: 'lax'`, and a
   24-hour `maxAge`.

   `sameSite: 'lax'` rather than `'strict'` is deliberate: the customer returns
   from Square's domain in WS-13, and a strict cookie would not be sent on that
   navigation.

   The signature is not confidentiality — item ids are not secret. It stops a
   customer hand-crafting a cookie whose contents bypass validation, and makes
   tampering detectable rather than silent.

2. **Implement the cart actions** in `actions.ts`, each wrapped in
   `authenticatedAction`:

   - `addCafeItemAction` — `{ catalogItemId, quantity }`; merges into an existing
     line rather than appending a duplicate.
   - `addClassSeatsAction` — `{ occurrenceId, participants }`; **replaces** the
     participant set for that occurrence rather than merging.
   - `updateCafeQuantityAction` — quantity `0` removes the line.
   - `removeLineAction` — removes a line.

   Replacement rather than merging for class seats is the safer semantic: merging
   two participant sets can silently produce duplicates or exceed the per-line
   cap, and the picker always submits the complete intended selection anyway.

   Every action re-reads the cart from the cookie, applies the delta, validates
   the result through `cartSchema`, and writes it back. Never trust a cart passed
   in the request body — the cookie is the state, the arguments are only the
   delta.

   Call `revalidatePath` after mutations so server-rendered summaries update.

3. **Validate participants belong to the household in the action too.** Load the
   session household's members and reject any submitted ref that is not among
   them, returning `VALIDATION`.

   WS-05 re-checks this at order creation and that is the authoritative boundary.
   This check exists so the customer gets an immediate, comprehensible error
   instead of a failure at checkout — it is a usability layer over a security
   control, not the control itself. Do not remove WS-05's check on the strength
   of this one.

4. **Build the participant picker** in `participant-picker.tsx`, a `'use client'`
   island. Load members through a Server Component parent calling
   `listHouseholdMembers`, render them via a new `ParticipantChecklist` in
   `@keki/ui`, and submit the selected refs.

   Show the seat count as **derived** from the number selected — never a separate
   number input. Two sources for seat count would eventually disagree.

   Disable selection beyond `seatsRemaining` as a courtesy, but do not present
   this as authoritative: the value is stale on arrival and WS-05's hold is the
   real check. The picker must still handle a `CONFLICT` from a sold-out race.

   When the household has no members beyond the account holder, render the
   account holder as the only option rather than an empty list — a customer
   booking a class for themselves is a normal case.

5. **Build the add-to-cart island** in `add-to-cart-button.tsx` for cafe items:
   quantity stepper plus submit, disabled while pending via `useTransition`,
   rendering the `ActionResult` error message on failure.

6. **Mount both controls** into the WS-08 card footer slot — the stepper for cafe
   items, the picker for class occurrences.

7. **Implement server-side cart resolution** in `resolve-cart.ts`. Read the
   cookie, resolve every line against the catalog, and return a view carrying
   name, unit price, quantity, participant display names, line total, and
   subtotal.

   Resolve prices here rather than trusting anything in the cookie. This is the
   same rule WS-05 applies at order creation, applied to display.

8. **Build the review page** at `/cart`, rendering the resolved view through a
   new `CartSummary` in `@keki/ui`. For class lines, list the named participants
   — the customer must be able to confirm who they are booking.

   Render a line whose item has been archived, whose class has sold out, or whose
   occurrence has passed as **unavailable with a remove control**, rather than
   omitting it silently. A customer must be able to see why checkout will refuse.

   Display the subtotal with an explicit note that tax is calculated at checkout.
   Square computes the authoritative total; presenting our subtotal as the final
   charge would be wrong the moment tax applies.

9. **Do not add a checkout button, a Square client, or an order-creating action.**
   That is WS-13. The review page ends at the summary.

10. **Run all four scripts** for both packages.

## Tests

Vitest with `@keki/catalog-core`, `@keki/customer-core`, and
`@keki/commerce-core` mocked at the module boundary.

1. **Cart cookie round-trips** — Write then read; assert equality.
2. **Tampered cookie yields an empty cart** — Flip a byte; assert empty, no
   throw.
3. **Unsigned cookie is rejected** — Assert empty.
4. **Cookie failing `cartSchema` yields an empty cart** — Sign a payload with a
   negative quantity; assert empty.
5. **A cookie carrying a price is rejected** — Sign a payload including
   `unitPriceCents`; assert empty. **SC-04 at the cookie boundary.**
6. **A cookie carrying an occurrence `quantity` is rejected** — Assert empty,
   proving seat count has one source.
7. **Cookie flags are set** — `httpOnly`, `sameSite: 'lax'`, bounded `maxAge`.
8. **`addCafeItemAction` appends a line.**
9. **Adding an existing cafe item merges quantity** — Add twice; assert one line
   with quantity 2.
10. **`addClassSeatsAction` replaces participants** — Add two, then one; assert
    the line holds exactly one.
11. **`updateCafeQuantityAction` with 0 removes the line.**
12. **Cart actions require authentication** — Assert an anonymous call returns
    `UNAUTHENTICATED` and never touches the cookie.
13. **A foreign child is rejected by the action** — Submit a ref outside the
    household; assert `VALIDATION` and an unchanged cookie.
14. **A duplicate participant is rejected** — Same child twice in one submission.
15. **Empty participant selection is rejected** — Assert `VALIDATION`.
16. **Picker renders only household members** — Mock a household of three; assert
    exactly those three, and that a member of another household never appears.
17. **Picker shows the account holder when there are no children** — Assert one
    selectable option, not an empty state.
18. **Seat count derives from selection** — Select two; assert the UI shows two
    seats with no quantity input present.
19. **Review page renders server-recomputed totals** — Mock a 500¢ item at
    quantity 3; assert `$15.00`. **This is SC-03.**
20. **No displayed price originates from the cookie** — Sign a cookie whose
    (stripped) fields would imply a different price; assert the rendered price
    comes from the mocked catalog.
21. **Review page names class participants** — Assert each selected member's
    display name renders. **This is SC-17's review half.**
22. **Archived line renders unavailable with a remove control** — Assert it is
    shown, not omitted.
23. **Sold-out class line renders unavailable** — Assert the same treatment.
24. **Subtotal is labelled as excluding tax** — Assert the note renders.
25. **No checkout control exists on the review page** — Assert no order-creating
    action is importable from this workstream's modules, proving the WS-13
    boundary.

## Acceptance Criteria

1. `apps/web` and `packages/ui` pass all four scripts.
2. The cart cookie is signed, `httpOnly`, `sameSite: 'lax'`, bounded, and
   validated through `cartSchema` on read; any failure yields an empty cart
   (tests 2–6).
3. Neither a price nor an occurrence quantity can survive the cookie boundary,
   and no displayed amount originates from it (tests 5, 6, 20).
4. Every cart action goes through `authenticatedAction`; none resolves a session
   itself.
5. Class seats are assigned to named household members, and seat count derives
   from the selection with no separate quantity input (tests 10, 18). **SC-17.**
6. The picker offers only the session household's members, and the action rejects
   a foreign ref as a usability layer over WS-05's authoritative check
   (tests 13, 16).
7. The review page shows a correct server-recomputed subtotal and names every
   class participant (tests 19, 21). **SC-03.**
8. Unavailable lines render with a remove control rather than disappearing.
9. The subtotal is labelled as excluding tax.
10. No checkout, order creation, or Square interaction is added (test 25).
