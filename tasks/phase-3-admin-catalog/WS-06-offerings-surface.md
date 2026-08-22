# WS-06: `/admin/offerings` — list, create, edit, publish, archive

## Goal

Replace the `/admin/offerings` placeholder with the surface where a manager
creates a class and makes it sellable.

This is where publishing happens, and publishing is the moment a class becomes
purchasable by real customers. The page should say so rather than presenting it
as one control among several.

## Traceability

- **SC-13** — `/admin/offerings` lists offerings with status and supports
  create, edit, publish, and archive.
- **SC-01** — A manager can create a `CLASS` offering through the UI, saved as
  `DRAFT`.
- **SC-03** — Publish and archive controls drive the status transitions.

## Dependencies

- **WS-05** — Admin Server Actions.

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Auth" and "Module boundaries"; `packages/ui` is
  presentational and consumed only by `apps/web`
- `docs/vision.md` — "Target Users"; the Manager/Admin persona
- `apps/web/app/admin/offerings/page.tsx` — the placeholder being replaced
- `apps/web/app/admin/layout.tsx` — the existing `requireRole('MANAGER')` and
  the surface nav
- `apps/web/app/admin/actions/offering-actions.ts` — WS-05's actions
- `apps/web/app/(customer)/book/cafe-menu.tsx` — the Server Component +
  client-island pattern to follow
- `packages/ui/src/components/price.tsx` — `Price`, the single place money is
  formatted
- `packages/ui/src/components/index.ts` — the barrel
- `packages/catalog-admin/src/queries.ts` — `listOfferings`, which returns
  every status

## Package

`apps/web` and `packages/ui`

## Files Touched

- `apps/web/app/admin/offerings/page.tsx` (MODIFY — replace the placeholder)
- `apps/web/app/admin/offerings/offering-form.tsx` (NEW — client island)
- `apps/web/app/admin/offerings/offering-row.tsx` (NEW — client island for transitions)
- `apps/web/app/admin/offerings/page.test.tsx` (NEW)
- `apps/web/app/admin/offerings/offering-form.test.tsx` (NEW)
- `packages/ui/src/components/status-badge.tsx` (NEW)
- `packages/ui/src/components/form-field.tsx` (NEW)
- `packages/ui/src/components/status-badge.test.tsx` (NEW)
- `packages/ui/src/components/index.ts` (MODIFY — barrel)
- `apps/web/app/nav-config.test.ts` (MODIFY — offerings is no longer a placeholder)

## Existing Interfaces to Consume

The placeholder being replaced, in full:

```tsx
import { PageShell, PlaceholderPanel } from '@keki/ui';

export default function OfferingsPage() {
  return (
    <PageShell title="Offerings" description="Define classes, rooms, and open-play sessions.">
      <PlaceholderPanel title="Offering management" plannedFor="Phase 2" />
    </PageShell>
  );
}
```

WS-05's actions and the envelope they return:

```ts
export const createOfferingAction: (raw: unknown) => Promise<ActionResult<Offering>>;
export const updateOfferingAction: (raw: unknown) => Promise<ActionResult<{ before: Offering; after: Offering }>>;
export const publishOfferingAction: (raw: unknown) => Promise<ActionResult<{ offering: Offering; changed: boolean }>>;
export const unpublishOfferingAction: (raw: unknown) => Promise<ActionResult<{ offering: Offering; changed: boolean }>>;
export const archiveOfferingAction: (raw: unknown) => Promise<ActionResult<{ offering: Offering; changed: boolean }>>;

export type ActionResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: ActionError };
```

WS-02's admin read, which unlike the customer-facing queries returns every
status:

```ts
export async function listOfferings(): Promise<readonly Offering[]>;
```

`Price`, the one place cents become a formatted string:

```tsx
export function Price({ cents, currency }: { cents: number; currency: string }): JSX.Element;
```

## Implementation Steps

1. **Add `StatusBadge`** to `packages/ui`: a small pill taking a label and a
   tone (`neutral`, `accent`, `muted`). Presentational only — it must not know
   what an offering status is, so the staff and reservations surfaces can reuse
   it with their own vocabularies.

2. **Add `FormField`** to `packages/ui`: a label, a control slot, an optional
   hint, and an optional error message. The admin forms are the first in the
   codebase, and every later staff form should not re-invent field markup.

3. **Build the list** in `page.tsx` as a Server Component calling
   `listOfferings()`. For each offering show name, status badge, duration,
   capacity, and price via `Price`.

   Group by status with `DRAFT` first, then `PUBLISHED`, then `ARCHIVED`.
   Drafts are the unfinished work a manager came to finish; archived rows are
   history and belong last.

   Render an `EmptyState` when there are no offerings at all — that is the
   first-run condition, and it should invite creating one rather than showing a
   bare heading.

4. **Build the create/edit form** in `offering-form.tsx` as a `'use client'`
   island: name, description, duration in minutes, capacity, and price.

   **Price is entered in dollars and converted to integer cents at the
   boundary.** Managers think in dollars; the database stores cents. Parse with
   an explicit conversion (`Math.round(dollars * 100)`) rather than passing a
   float through — and never let a fractional cent reach the action.

   `type` is not a field. Only `CLASS` is supported this program, and rendering
   a disabled or single-option selector implies the others are coming
   momentarily. State it in the page's description instead.

   Disable the submit control while pending via `useTransition`, and render
   `result.error.message` on failure.

5. **Build the transition controls** in `offering-row.tsx`, another client
   island. Which controls appear depends on status, driven by the same
   transition table the server enforces:

   - `DRAFT` → Publish, Archive
   - `PUBLISHED` → Unpublish, Archive
   - `ARCHIVED` → none

   The UI must not offer a control the server will refuse. It is a convenience,
   not the guard — WS-05's actions are — but offering an impossible action and
   then failing is a worse experience than not offering it.

6. **Say what publishing does.** Next to the Publish control, state plainly
   that publishing makes the class visible on the customer booking page. A
   manager should not have to discover that by publishing and checking.

   Similarly, confirm before archiving: it is terminal, and the transition
   table has no way back.

7. **Update `nav-config.test.ts`**: remove `/admin/offerings` from the
   placeholder brief and add `admin${sep}offerings${sep}` to the data-access
   allowlist, matching how `/account` and `/book` were handled.

8. **Run all four scripts** for both packages.

## Tests

Component tests with Vitest; `@keki/catalog-admin` and the actions mocked at
the module boundary.

1. **`StatusBadge` renders its label** — Assert the text appears.
2. **`StatusBadge` applies a distinct class per tone** — Assert `accent` and
   `muted` differ, so the statuses are visually distinguishable rather than
   uniformly styled.
3. **`FormField` associates its label with its control** — Assert the label's
   `htmlFor` matches the control id, so the form is usable by keyboard and
   screen reader.
4. **`FormField` renders an error when given one** — Assert the message appears
   and is absent otherwise.
5. **The list renders every offering with its status** — Mock one of each
   status; assert all three appear with the right badges. **This is SC-13.**
6. **Drafts sort before published, which sort before archived** — Assert the
   rendered order, since a manager comes to finish drafts.
7. **An empty catalog renders an empty state** — Mock `[]`; assert the empty
   state, not a bare heading. This is the first-run condition.
8. **Price renders from cents** — Mock `priceCents: 4500`; assert `$45.00`.
9. **The form converts dollars to integer cents** — Enter `45.50`; assert the
   action received `priceCents: 4550`, an integer.
10. **A fractional cent is rounded, not truncated or passed through** — Enter
    `45.555`; assert `4556` reaches the action and that it is an integer.
    Passing a float would corrupt every downstream total.
11. **The form has no type selector** — Assert no control for offering type is
    rendered, since only `CLASS` is supported.
12. **Submitting calls the create action with parsed values** — Assert name,
    duration, and capacity arrive as numbers, not strings.
13. **The submit control disables while pending** — Assert it is disabled
    during the transition, so a double-click cannot create two offerings.
14. **A failed create renders the error message** — Mock `ok: false` with a
    `VALIDATION` message; assert it appears.
15. **A draft row offers Publish and Archive** — Assert both controls, and no
    Unpublish.
16. **A published row offers Unpublish and Archive** — Assert both, and no
    Publish.
17. **An archived row offers no transition controls** — Assert none, since
    `ARCHIVED` is terminal and offering a control the server refuses is worse
    than offering none.
18. **Publishing calls the publish action with the offering id** — Assert the
    id, and that no status is sent from the client.
19. **The Publish control states what publishing does** — Assert the copy
    mentions the customer booking page, so the consequence is visible before
    the click.
20. **Archiving asks for confirmation** — Assert a confirmation step precedes
    the action, since the transition is terminal.
21. **A CONFLICT from a transition is surfaced** — Mock `ok: false` with
    `CONFLICT`; assert the message renders rather than failing silently.
22. **`packages/ui` imports no data layer** — Assert its `package.json`
    declares neither `@keki/catalog-admin` nor `@keki/database`.

## Acceptance Criteria

1. `apps/web` and `packages/ui` pass all four scripts.
2. `/admin/offerings` lists every offering with its status, grouped drafts
   first, and no longer renders `PlaceholderPanel` (tests 5–7). **SC-13.**
3. A manager can create a `CLASS` offering through the form, and it is saved as
   `DRAFT` (test 12). **SC-01.**
4. Price is entered in dollars and reaches the action as **integer cents**,
   rounded rather than truncated or passed as a float (tests 9–10).
5. No offering-type selector is rendered (test 11).
6. Transition controls match the transition table exactly, with none offered
   for `ARCHIVED` (tests 15–17). **SC-03.**
7. The client never sends a target status; the action fixes it (test 18).
8. The Publish control states that publishing makes the class visible to
   customers, and archiving is confirmed first (tests 19–20).
9. Action failures render their message rather than failing silently (tests
   14, 21).
10. `packages/ui` stays presentational, with `StatusBadge` and `FormField`
    knowing nothing about offerings (tests 1–4, 22).
11. `nav-config.test.ts` no longer treats `/admin/offerings` as a placeholder.
