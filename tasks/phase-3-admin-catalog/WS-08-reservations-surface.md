# WS-08: `/admin/reservations` — who booked what, per occurrence

## Goal

Replace the `/admin/reservations` placeholder with a read-only view of who is
booked on each upcoming occurrence, with participant names.

This is the question staff ask before a class runs — "who is coming, and how
many" — and today the only way to answer it is a SQL query.

Read-only. Check-in belongs to the staff surface and is not in this program;
editing or moving a reservation is out of scope entirely.

## Traceability

- **SC-15** — `/admin/reservations` shows who is booked on an occurrence, with
  participant names.

## Dependencies

- **WS-03** — catalog-admin occurrence reads (the occurrence list and booked
  counts this page is organised around).

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Auth" and "Data access"
- `docs/vision.md` — "Core Concepts"; Reservation, Child, Household
- `apps/web/app/admin/reservations/page.tsx` — the placeholder being replaced
- `apps/web/app/(customer)/orders/[orderId]/page.tsx` — how participant names
  are resolved from a reservation, the pattern to reuse rather than re-derive
- `packages/reservation-core/src/queries.ts` — the reservation reads
- `packages/customer-core/src/queries.ts` — `listHouseholdMembers`
- `packages/catalog-admin/src/queries.ts` — `listUpcomingOccurrences`
- `packages/ui/src/components/status-badge.tsx` — WS-06's badge

## Package

`apps/web` and `packages/ui`

## Files Touched

- `apps/web/app/admin/reservations/page.tsx` (MODIFY — replace the placeholder)
- `apps/web/app/admin/reservations/occurrence-roster.tsx` (NEW)
- `apps/web/app/admin/reservations/page.test.tsx` (NEW)
- `apps/web/app/nav-config.test.ts` (MODIFY — reservations is no longer a placeholder)

## Existing Interfaces to Consume

The placeholder being replaced:

```tsx
import { PageShell, PlaceholderPanel } from '@keki/ui';

export default function ReservationsPage() {
  return (
    <PageShell title="Reservations" description="Resolve and inspect bookings.">
      <PlaceholderPanel title="Reservation management" plannedFor="Phase 2" />
    </PageShell>
  );
}
```

How the customer order page resolves participant names — this page needs the
same mapping and should reuse the approach rather than inventing a second one:

```tsx
import { listParticipantsForReservation } from '@keki/reservation-core';
import { listHouseholdMembers } from '@keki/customer-core';
import { cartParticipantRefKey } from '@keki/contracts';

// participants are CartParticipantRef values (customer XOR child); names come
// from the household's members, keyed by cartParticipantRefKey.
```

The reservation reads:

```ts
export async function listReservationsForOccurrence(
  occurrenceId: OccurrenceId,
): Promise<readonly Reservation[]>;

export async function listParticipantsForReservation(
  reservationId: ReservationId,
): Promise<readonly CartParticipantRef[]>;
```

WS-03's occurrence list, which this page is organised around:

```ts
export async function listUpcomingOccurrences(input?: {
  from?: Date;
  limit?: number;
}): Promise<readonly AdminOccurrenceView[]>;
```

## Implementation Steps

1. **Build the page** in `page.tsx` as a Server Component. Load upcoming
   occurrences, and for a selected occurrence load its reservations and
   participants.

   Take the occurrence from a `searchParams` value rather than component
   state, so a roster is linkable — staff will want to send one to a colleague,
   and a client-state selection cannot be shared.

   Default to the **next** upcoming occurrence when none is selected. Landing
   on an empty page with a chooser is a worse first impression than landing on
   the roster most likely to be wanted.

2. **Resolve participant names** in `occurrence-roster.tsx`. Reservations carry
   participant refs (customer XOR child), not names; names come from the
   booking household's members.

   Load each reservation's household members once and key by
   `cartParticipantRefKey`, exactly as the order status page does. Do not
   re-derive the key format here — a second implementation of that mapping will
   drift from the first.

   Render `'Unknown participant'` rather than crashing when a ref does not
   resolve. A child removed from a household after booking is a real state, and
   a roster that throws is useless precisely when someone needs it.

3. **Show reservation status per row.** `HELD` reservations are in-progress
   checkouts, not attendees — a roster that lists them as booked overstates
   attendance. Show status via `StatusBadge` and group confirmed reservations
   first.

4. **Render the seat total.** Sum `seat_count` across confirmed reservations
   and show it against capacity, matching the count `/admin/schedules` shows
   for the same occurrence. Two admin pages disagreeing about one class is
   worse than either being absent.

5. **Handle the empty roster** — an occurrence with no reservations is
   ordinary, especially just after scheduling. Say "no bookings yet" rather
   than rendering an empty table.

6. **Do not add check-in, cancellation, or any mutation.** Check-in belongs to
   the staff surface, and this program's scope is explicit that reservations
   are read-only here. Adding a control would also require reservation-mutating
   commands this program does not build.

7. **Avoid N+1 where it matters.** Loading participants per reservation is a
   query each; for a roster of a few dozen that is acceptable, but load the
   household members in one pass keyed by household rather than once per
   reservation.

8. **Update `nav-config.test.ts`**: remove `/admin/reservations` from the
   placeholder brief and add `admin${sep}reservations${sep}` to the data-access
   allowlist.

9. **Run all four scripts** for both packages.

## Tests

Component tests with Vitest; `@keki/reservation-core`, `@keki/customer-core`,
and `@keki/catalog-admin` mocked at the module boundary.

1. **The roster lists booked participants by name** — Mock a reservation with
   one child participant; assert the child's name renders, not an id. **This is
   SC-15.**
2. **A customer participant renders their name** — Assert the adult case works
   as well as the child case, since both are valid participant kinds.
3. **Multiple participants on one reservation all render** — Mock two; assert
   both names appear.
4. **An unresolvable participant renders a fallback** — Mock a ref with no
   matching household member; assert `'Unknown participant'` appears and the
   page does not throw. A child removed after booking is a real state.
5. **Reservation status is shown per row** — Mock one `CONFIRMED` and one
   `HELD`; assert both statuses render distinctly.
6. **Confirmed reservations group before held** — Assert the order, since held
   rows are in-progress checkouts rather than attendees.
7. **The seat total counts confirmed seats** — Mock two confirmed reservations
   with `seat_count` 2 and 1; assert `3` renders.
8. **The seat total matches what the schedules page shows** — Assert it counts
   the same statuses `listUpcomingOccurrences` counts, so the two admin pages
   cannot disagree about one class.
9. **An occurrence with no reservations renders a message** — Assert "no
   bookings yet" rather than an empty table.
10. **The selected occurrence comes from searchParams** — Assert a given
    occurrence id renders that roster, so the view is linkable.
11. **The next upcoming occurrence is selected by default** — With no
    searchParams, assert the earliest upcoming occurrence's roster renders
    rather than an empty chooser.
12. **An unknown occurrence id renders not-found rather than crashing** —
    Assert a graceful result.
13. **No mutation controls are rendered** — Assert there is no check-in,
    cancel, or edit control, since this surface is read-only and the commands
    behind them do not exist.
14. **Household members are loaded once per household, not per reservation** —
    Mock three reservations from one household; assert `listHouseholdMembers`
    was called once, not three times.

## Acceptance Criteria

1. `apps/web` and `packages/ui` pass all four scripts.
2. `/admin/reservations` shows who is booked on an occurrence with participant
   names, for both customer and child participants, and no longer renders
   `PlaceholderPanel` (tests 1–3). **SC-15.**
3. An unresolvable participant renders a fallback rather than throwing
   (test 4).
4. Reservation status is visible and confirmed rows group first, so held
   checkouts are not mistaken for attendees (tests 5–6).
5. The seat total counts the same statuses `/admin/schedules` counts (tests
   7–8).
6. The selected occurrence is driven by `searchParams`, making a roster
   linkable, and defaults to the next upcoming one (tests 10–11).
7. An empty roster and an unknown occurrence both render gracefully (tests
   9, 12).
8. No mutation control of any kind is added (test 13).
9. Participant name resolution reuses `cartParticipantRefKey` rather than
   re-deriving the key format.
10. `nav-config.test.ts` no longer treats `/admin/reservations` as a
    placeholder.
