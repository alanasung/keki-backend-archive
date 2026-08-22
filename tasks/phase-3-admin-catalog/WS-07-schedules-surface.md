# WS-07: `/admin/schedules` — occurrence calendar, scheduling, cancellation

## Goal

Replace the `/admin/schedules` placeholder with the surface where a manager
puts a published class on the calendar.

This is the workstream that closes the loop: after it, a class created in
WS-06 and scheduled here appears on `/book` for customers to buy, with no
script and no engineer.

## Traceability

- **SC-14** — `/admin/schedules` lists upcoming occurrences by day with booked
  counts, and supports scheduling and cancellation.
- **SC-08** — Partially: surfaces the warning when capacity is lowered below
  the booked count. WS-03 supplies the count.
- **SC-09** — Partially: shows why a cancellation was refused.

## Dependencies

- **WS-05** — Admin Server Actions.

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Auth" and "Module boundaries"
- `docs/vision.md` — "Core Concepts"; Occurrence
- `apps/web/app/admin/schedules/page.tsx` — the placeholder being replaced
- `apps/web/app/admin/actions/occurrence-actions.ts` — WS-05's actions
- `apps/web/app/(customer)/book/class-listing.tsx` — the day-grouping and
  timezone handling this must match, so both surfaces describe the same class
  identically
- `packages/catalog-admin/src/queries.ts` — `listUpcomingOccurrences`
- `packages/ui/src/components/status-badge.tsx` — WS-06's badge
- `packages/ui/src/components/form-field.tsx` — WS-06's field

## Package

`apps/web` and `packages/ui`

## Files Touched

- `apps/web/app/admin/schedules/page.tsx` (MODIFY — replace the placeholder)
- `apps/web/app/admin/schedules/schedule-form.tsx` (NEW — client island)
- `apps/web/app/admin/schedules/occurrence-row.tsx` (NEW — client island)
- `apps/web/app/admin/schedules/page.test.tsx` (NEW)
- `apps/web/app/admin/schedules/schedule-form.test.tsx` (NEW)
- `apps/web/app/admin/schedules/occurrence-row.test.tsx` (NEW)
- `apps/web/app/nav-config.test.ts` (MODIFY — schedules is no longer a placeholder)

## Existing Interfaces to Consume

The placeholder being replaced:

```tsx
import { PageShell, PlaceholderPanel } from '@keki/ui';

export default function SchedulesPage() {
  return (
    <PageShell title="Schedules" description="Publish occurrences of each offering.">
      <PlaceholderPanel title="Schedule management" plannedFor="Phase 2" />
    </PageShell>
  );
}
```

WS-03's admin read, which unlike the customer query includes occurrences of
unpublished offerings:

```ts
export interface AdminOccurrenceView {
  readonly occurrenceId: OccurrenceId;
  readonly offeringId: OfferingId;
  readonly offeringName: string;
  readonly offeringStatus: OfferingStatus;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly capacity: number;
  readonly bookedSeats: number;
  readonly status: OccurrenceStatus;
}

export async function listUpcomingOccurrences(input?: {
  from?: Date;
  limit?: number;
}): Promise<readonly AdminOccurrenceView[]>;
```

WS-05's actions. Note `updateOccurrenceAction` always returns `bookedSeats`,
which is what makes the capacity warning possible:

```ts
export const scheduleOccurrenceAction: (raw: unknown) => Promise<ActionResult<Occurrence>>;
export const updateOccurrenceAction: (raw: unknown) => Promise<
  ActionResult<{ before: Occurrence; after: Occurrence; bookedSeats: number }>
>;
export const cancelOccurrenceAction: (raw: unknown) => Promise<
  ActionResult<{ occurrence: Occurrence; changed: boolean }>
>;
```

The customer surface's timezone handling, which this must match — the same
class must not read as Tuesday on one page and Wednesday on the other:

```tsx
// Occurrence times render in the cafe's timezone via a single named
// constant, because `occurrences` are timestamptz precisely so a business
// crossing DST does not show customers the wrong hour twice a year.
```

## Implementation Steps

1. **Build the list** in `page.tsx` as a Server Component calling
   `listUpcomingOccurrences()`. Group by calendar day, ascending, with a day
   heading — the same grouping `class-listing.tsx` uses, for the same reason:
   a flat undated list of times is unreadable past a handful of rows.

   Render times in the **cafe's timezone**, reusing the same named constant the
   customer surface uses rather than declaring a second one. Two constants
   drift, and then the two pages disagree about when a class starts.

   Per occurrence show: offering name, start and end, `bookedSeats / capacity`,
   and status.

2. **Mark occurrences whose offering is not published.** `listUpcomingOccurrences`
   deliberately includes them, and they are invisible on `/book` — a manager
   looking at a scheduled class that customers cannot see needs to know why.
   Show the offering's status when it is not `PUBLISHED`, with a short note
   that the class is not visible to customers.

3. **Show over-subscription plainly.** When `bookedSeats > capacity`, render
   the count in a way that reads as a problem, with the excess named. This is
   reachable through WS-03's permitted capacity reduction, and it is exactly
   the state a manager needs to act on — the customer page just says "sold
   out".

4. **Build the scheduling form** in `schedule-form.tsx` as a `'use client'`
   island: an offering selector, a date-and-time input, and an optional
   capacity override.

   **List only published offerings in the selector.** WS-03 refuses to schedule
   a draft, so offering one would produce a guaranteed failure. If no published
   offerings exist, say so and link to `/admin/offerings` rather than rendering
   an empty selector.

   Do not offer an end-time field — WS-03 derives it from the offering's
   duration. Show the computed end alongside the start once an offering and
   start are chosen, so the manager sees the span before submitting.

   Submit `startsAt` as an ISO string; WS-01's schema coerces it.

5. **Build the row controls** in `occurrence-row.tsx`: edit capacity, and
   cancel.

   **Capacity edit must surface the warning.** On success, if the returned
   `bookedSeats` exceeds the new capacity, show a message naming both numbers —
   the edit succeeded and the class is now over-subscribed. Do not present this
   as an error; it is a permitted, deliberate outcome. **SC-08.**

   **Cancellation must explain a refusal.** A `CONFLICT` from
   `cancelOccurrenceAction` carries the booked count; render that message
   rather than a generic failure. "Cannot cancel — 3 people are booked" is
   actionable; "something went wrong" is not. **SC-09.**

   Confirm before cancelling, and say that cancelling removes the class from
   the customer booking page.

   Show no cancel control on an already-cancelled occurrence.

6. **Update `nav-config.test.ts`**: remove `/admin/schedules` from the
   placeholder brief and add `admin${sep}schedules${sep}` to the data-access
   allowlist.

7. **Run all four scripts** for both packages.

## Tests

Component tests with Vitest; `@keki/catalog-admin` and the actions mocked at
the module boundary.

1. **Occurrences render grouped by day, ascending** — Mock occurrences across
   three days out of order; assert the day headings appear chronologically.
   **This is SC-14.**
2. **Times render in the cafe timezone** — Mock a UTC instant falling on the
   previous local day; assert the local date renders, proving the constant is
   applied rather than the server's zone.
3. **The same constant is used as the customer surface** — Assert the module
   imports the shared timezone constant rather than declaring its own, so the
   two pages cannot drift.
4. **Booked count renders against capacity** — Mock `bookedSeats: 3`,
   `capacity: 8`; assert `3 / 8` appears.
5. **An occurrence of an unpublished offering is marked** — Mock
   `offeringStatus: 'DRAFT'`; assert the row says the class is not visible to
   customers.
6. **An occurrence of a published offering is not marked** — Assert the notice
   is absent, so it carries signal.
7. **Over-subscription is shown as a problem** — Mock `bookedSeats: 5`,
   `capacity: 2`; assert the excess is named rather than rendered as an
   ordinary count.
8. **An empty schedule renders an empty state** — Mock `[]`; assert the empty
   state rather than a bare heading.
9. **The selector lists only published offerings** — Mock one `DRAFT`, one
   `PUBLISHED`, one `ARCHIVED`; assert only the published one is selectable.
   Offering a draft would guarantee a refusal from WS-03.
10. **No published offerings renders guidance, not an empty selector** — Assert
    the message links to `/admin/offerings`.
11. **The form has no end-time field** — Assert none is rendered, since the end
    is derived.
12. **The computed end is shown before submitting** — Choose a 90-minute
    offering and a 10:00 start; assert `11:30` is displayed.
13. **Submitting sends an ISO start** — Assert the action received a string the
    schema can coerce, not a `Date` object or a locale-formatted string.
14. **A past-date refusal renders its message** — Mock `ok: false` with
    `VALIDATION`; assert the message appears.
15. **An overlap refusal names the conflict** — Mock `ok: false` with
    `CONFLICT` naming a time; assert it renders.
16. **Lowering capacity below bookings shows a warning, not an error** — Mock a
    successful update returning `bookedSeats: 3` against a new capacity of 2;
    assert a warning naming both numbers appears and that it is not presented
    as a failure. **This is SC-08.**
17. **A capacity edit that stays above bookings shows no warning** — Assert the
    warning is absent, so it carries signal.
18. **A refused cancellation renders the reason with the count** — Mock
    `ok: false` with `CONFLICT` carrying "3 people are booked"; assert the
    count appears rather than a generic failure. **This is SC-09.**
19. **Cancelling asks for confirmation first** — Assert a confirmation step
    precedes the action.
20. **The confirmation says customers will lose access** — Assert the copy
    mentions the customer booking page.
21. **A cancelled occurrence shows no cancel control** — Assert it is absent,
    since the server would refuse.
22. **The submit control disables while pending** — Assert it is disabled
    during the transition, so a double-click cannot schedule twice.

## Acceptance Criteria

1. `apps/web` and `packages/ui` pass all four scripts.
2. `/admin/schedules` lists upcoming occurrences grouped by day with booked
   counts and no longer renders `PlaceholderPanel` (tests 1, 4). **SC-14.**
3. Times render in the cafe's timezone using the **same constant** as the
   customer surface, so the two cannot disagree (tests 2–3).
4. Occurrences of unpublished offerings are listed and marked as invisible to
   customers (tests 5–6).
5. Over-subscription is rendered as a problem with the excess named (test 7).
6. The scheduling selector offers only published offerings, and explains itself
   when there are none (tests 9–10).
7. No end-time field exists; the derived end is shown before submitting
   (tests 11–12).
8. Lowering capacity below bookings renders a warning naming both numbers and
   is not presented as a failure (tests 16–17). **SC-08.**
9. A refused cancellation renders the booked count from the server's message
   (test 18). **SC-09.**
10. Cancelling is confirmed, states the customer-facing consequence, and is not
    offered on an already-cancelled occurrence (tests 19–21).
11. `nav-config.test.ts` no longer treats `/admin/schedules` as a placeholder.
