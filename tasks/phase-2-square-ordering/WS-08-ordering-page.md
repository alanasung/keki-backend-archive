# WS-08: Ordering page — cafe menu and class listing

## Goal

Replace the `/book` placeholder with the real ordering page: cafe items from the
Square catalog cache and bookable class occurrences with prices, times, and
remaining seats.

Read-only rendering. The cart and checkout arrive in WS-09 — this workstream
delivers the surface they attach to, plus the shared presentational primitives
in `@keki/ui`.

## Traceability

- **SC-01** — The ordering page lists cafe items sourced from the Square Catalog
  cache, with name, description, and price.
- **SC-02** — The ordering page lists published class occurrences with start
  time, price, and remaining seats.

## Dependencies

- **WS-04** — catalog-core (`listCafeItems`, `listBookableOfferings`).
- **WS-07** — Server Action foundation (established before any interactive
  surface is built on this page).

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Module boundaries"; `packages/ui` is presentational and
  consumed only by `apps/web`
- `docs/vision.md` — "Target Users"; the customer surface and what it is for
- `apps/web/app/(customer)/book/page.tsx` — the placeholder being replaced
- `packages/ui/src/index.ts` — existing exports (`SurfaceNav`, `PageShell`,
  `PlaceholderPanel`, `cn`)
- `packages/contracts/src/catalog.ts` — `CafeItemView` and
  `BookableOccurrenceView` from WS-01
- `packages/catalog-core/src/queries.ts` — the read functions from WS-04
- `apps/web/app/auth/guards.ts` — `requireRole`, the layout-level gate

## Package

`apps/web` and `packages/ui`

## Files Touched

- `apps/web/app/(customer)/book/page.tsx` (MODIFY) — the real ordering page
- `apps/web/app/(customer)/book/cafe-menu.tsx` (NEW) — cafe item section
- `apps/web/app/(customer)/book/class-listing.tsx` (NEW) — class section
- `apps/web/app/(customer)/book/page.test.tsx` (NEW)
- `packages/ui/src/components/catalog-item-card.tsx` (NEW)
- `packages/ui/src/components/price.tsx` (NEW) — currency formatting
- `packages/ui/src/components/empty-state.tsx` (NEW)
- `packages/ui/src/components/index.ts` (MODIFY) — barrel
- `packages/ui/src/components/price.test.tsx` (NEW)
- `packages/ui/src/components/catalog-item-card.test.tsx` (NEW)

## Existing Interfaces to Consume

The page being replaced, in full — this is the entire current implementation:

```tsx
import { PageShell, PlaceholderPanel } from '@keki/ui';

export default function BookPage() {
  return (
    <PageShell title="Book" description="Browse and book classes, rooms, and open-play sessions.">
      <PlaceholderPanel title="Booking" plannedFor="Phase 2" />
    </PageShell>
  );
}
```

The view types from WS-01. Note `seatsRemaining` is documented as display-only:

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
```

The WS-04 read functions:

```ts
export declare function listCafeItems(): Promise<readonly CafeItemView[]>;
export declare function listBookableOfferings(input?: {
  from?: Date;
  to?: Date;
  types?: readonly OfferingType[];
}): Promise<readonly BookableOccurrenceView[]>;
```

The existing gate, already applied at the `(customer)` layout:

```ts
export async function requireRole(requiredRole: Role): Promise<Session>;
```

## Implementation Steps

1. **Add `Price`** to `packages/ui`. Format integer cents by currency using
   `Intl.NumberFormat`:

   ```tsx
   export function Price({ cents, currency }: { cents: number; currency: string }): JSX.Element;
   ```

   Divide by 100 exactly once, here. Scattering `/100` through JSX is how a
   price eventually renders as `$4.5` or `$450`. Never use floating-point
   arithmetic to sum money — all totals stay in integer cents and are formatted
   only at the edge.

2. **Add `CatalogItemCard`** to `packages/ui`: name, optional description,
   `Price`, and an optional footer slot for the action WS-09 will place there.

   Keep it presentational — no data fetching, no Server Action imports. It takes
   props and renders. That boundary is what lets WS-09 add a cart button without
   touching this file's logic.

3. **Add `EmptyState`** to `packages/ui` for the "no items" and "no classes"
   cases.

4. **Build the cafe section** in `cafe-menu.tsx` as a Server Component calling
   `listCafeItems()`. Render a `CatalogItemCard` per item; render `EmptyState`
   when the list is empty.

   An empty menu is a real state — it happens when the catalog sync has never
   run or Square returned nothing. It must render as a calm empty state, not a
   crash or a blank region.

5. **Build the class section** in `class-listing.tsx` as a Server Component
   calling `listBookableOfferings()`. For each occurrence render name,
   description, formatted start time, price, and seat availability.

   Group by calendar day, ordered ascending. A flat undated list of times is
   unreadable once more than a few classes exist.

   Render `startsAt` in the cafe's local timezone, not the server's. The schema
   comment on `occurrences` is explicit that these are `timestamptz` because a
   cafe with scheduled programming crosses DST boundaries — formatting in UTC
   would show customers the wrong hour twice a year. Use a single named
   constant for the display timezone.

   Show "Sold out" when `seatsRemaining <= 0`, and a low-seat hint when it is
   small. Do not disable purchasing based on this number in a way that implies
   it is authoritative — it is stale on arrival, and WS-02's trigger is the real
   check. WS-09 must still handle a `CONFLICT` from a sold-out race.

6. **Assemble the page** in `page.tsx`: keep `PageShell`, update the description,
   and render both sections. Remove the `PlaceholderPanel` import.

   Fetch both sections' data concurrently with `Promise.all` rather than
   sequentially — two independent queries awaited in series double the page's
   latency for no reason.

7. **Set revalidation deliberately.** The page reads cached catalog data but
   live seat counts. Mark it dynamic (`export const dynamic = 'force-dynamic'`)
   so seat availability is not served from a stale full-route cache. Comment
   why: a cached seat count is a customer clicking "book" on a class that filled
   an hour ago.

8. **Do not add a cart, a button that mutates, or any `'use client'` island that
   posts.** That is WS-09. The footer slot is the seam.

9. **Run all four scripts** for both packages.

## Tests

Component tests with Vitest; `@keki/catalog-core` mocked at the module boundary.

1. **`Price` formats cents to currency** — Assert `1234` → `$12.34` for USD.
2. **`Price` handles zero and large values** — Assert `0` → `$0.00` and
   `1234567` → `$12,345.67`.
3. **`Price` respects a non-USD currency** — Assert the symbol changes.
4. **`CatalogItemCard` renders name, description, and price** — Assert all three
   appear.
5. **`CatalogItemCard` tolerates a null description** — Assert no crash and no
   stray empty element.
6. **`CatalogItemCard` renders its footer slot** — Assert supplied children
   appear, proving the WS-09 seam.
7. **Cafe section lists every item** — Mock three items; assert three cards.
8. **Cafe section renders an empty state** — Mock `[]`; assert the empty state,
   not a crash. **This is the never-synced case.**
9. **Class section lists occurrences with time, price, and seats** — Assert all
   three render. **This is SC-02.**
10. **Class section groups by day in ascending order** — Mock occurrences across
    two days out of order; assert day headings appear in chronological order.
11. **Start times render in the cafe timezone** — Mock an occurrence at a UTC
    instant that falls on the previous local day; assert the local date renders,
    proving the timezone is applied.
12. **Sold-out occurrences are labelled** — Mock `seatsRemaining: 0`; assert
    "Sold out".
13. **Low availability is surfaced** — Mock `seatsRemaining: 1`; assert the hint.
14. **Class section renders an empty state** — Mock `[]`; assert the empty
    state.
15. **The page renders both sections** — Assert cafe items and classes both
    appear. **This is SC-01 plus SC-02.**
16. **The page fetches concurrently** — Assert both mocked queries were invoked
    before either resolved.
17. **The placeholder is gone** — Assert `PlaceholderPanel` is not rendered on
    `/book`.
18. **`packages/ui` imports no data layer** — Assert its `package.json` declares
    neither `@keki/catalog-core` nor `@keki/database`.

## Acceptance Criteria

1. `apps/web` and `packages/ui` pass all four scripts.
2. `/book` renders real cafe items from the catalog cache with name,
   description, and price (SC-01).
3. `/book` renders published class occurrences with start time, price, and
   remaining seats (SC-02).
4. `PlaceholderPanel` no longer appears on `/book`.
5. Both empty states render calmly rather than crashing.
6. Money is formatted in exactly one place, and all arithmetic stays in integer
   cents.
7. Occurrence times render in the cafe's timezone via a single named constant.
8. Classes are grouped by day in chronological order.
9. The page is dynamic, so seat counts are not served from a stale route cache,
   with a comment explaining why.
10. Both queries are fetched concurrently.
11. `packages/ui` remains presentational, with a footer slot as the WS-09 seam
    and no data-layer dependency.
12. No cart, mutation, or checkout behavior is added.
