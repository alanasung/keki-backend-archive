# WS-08: `/staff/occupancy` — who is in the building now

## Goal

Replace the `/staff/occupancy` placeholder with a headcount of the people
currently in the building, broken down by class.

This is the question staff and safety rules care about, and today it has no
answer anywhere in the system.

It is also the surface where honesty matters most. There is no check-out, so
this number is derived from who checked in to a class that has not yet ended.
The page must say that plainly rather than presenting a derived approximation
as a live door count.

Read-only. Check-in belongs to WS-07.

## Traceability

- **SC-15** — `/staff/occupancy` reports checked-in participants of in-progress
  occurrences, excludes occurrences that have ended, and states its as-of time.

## Dependencies

- **WS-04** — `staff-ops` queries (`getCurrentOccupancy`).

> Deliberately **not** dependent on WS-05: this surface is read-only and needs
> no Server Action, so it can be built as soon as the query exists.

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Auth" and "Module boundaries"
- `docs/vision.md` — "The Problem"; nobody has a single view of who is in the
  building right now
- `apps/web/app/staff/occupancy/page.tsx` — the placeholder being replaced
- `apps/web/app/staff/layout.tsx` — the existing `requireRole('FRONT_OF_HOUSE')`
- `packages/staff-ops/src/queries.ts` — WS-04's `getCurrentOccupancy` and the
  `OccupancySnapshot` shape
- `packages/contracts/src/entities.ts` — `CAFE_TIME_ZONE`
- `packages/ui/src/components/count-meter.tsx` — WS-06's meter, reused here
- `packages/ui/src/components/empty-state.tsx` — the empty state
- `apps/web/app/nav-config.test.ts` — the placeholder brief and allowlist

## Package

`apps/web` and `packages/ui`

## Files Touched

- `apps/web/app/staff/occupancy/page.tsx` (MODIFY — replace the placeholder)
- `apps/web/app/staff/occupancy/occupancy-lines.tsx` (NEW)
- `apps/web/app/staff/occupancy/refresh-button.tsx` (NEW — client island)
- `apps/web/app/staff/occupancy/page.test.tsx` (NEW)
- `apps/web/app/nav-config.test.ts` (MODIFY — occupancy is no longer a placeholder)

## Existing Interfaces to Consume

The placeholder being replaced, in full:

```tsx
import { PageShell, PlaceholderPanel } from '@keki/ui';

export default function StaffOccupancyPage() {
  return (
    <PageShell title="Occupancy" description="See who is currently in the building.">
      <PlaceholderPanel title="Current occupancy" plannedFor="Phase 2" />
    </PageShell>
  );
}
```

> `docs/as-built.md` currently says this page "still renders fake data." It
> does not — it is the plain `PlaceholderPanel` above. Trust the source.

WS-04's query. Note `asOf` exists precisely so this page can state its own
freshness:

```ts
export interface OccupancyLine {
  readonly occurrenceId: OccurrenceId;
  readonly offeringName: string;
  readonly endsAt: Date;
  readonly headcount: number;
}

export interface OccupancySnapshot {
  readonly asOf: Date;
  readonly totalHeadcount: number;
  readonly lines: readonly OccupancyLine[];
}

export async function getCurrentOccupancy(input?: {
  now?: Date;
}): Promise<OccupancySnapshot>;
```

## Implementation Steps

1. **Build the page** in `page.tsx` as a Server Component calling
   `getCurrentOccupancy()`. Force it dynamic — a cached occupancy count is
   worse than none, because it is confidently wrong.

2. **Lead with the total.** `totalHeadcount` is the number someone is walking
   over to read, so render it large and first, before any breakdown.

3. **Build the per-class breakdown** in `occupancy-lines.tsx`: one line per
   in-progress occurrence with its class name, headcount, and when it ends.

   Show **when each class ends**, because that is when those people stop
   counting. It turns an opaque number into one a staff member can predict.

4. **State the limitation on the page, not in a comment.** Say plainly that the
   count reflects people checked in to classes that have not yet ended, and
   that there is no check-out — someone who left early still counts.

   This is the difference between a number staff trust correctly and one they
   trust wrongly. It belongs in the interface.

5. **State the as-of time** from `snapshot.asOf`, rendered in `CAFE_TIME_ZONE`.
   The page is a snapshot at load, not a live feed, and saying so is what makes
   a stale tab harmless.

6. **Add a refresh control** in `refresh-button.tsx` as a `'use client'`
   island calling `router.refresh()`. This is the whole freshness story — no
   polling, no streaming, per the program's decision. A staff member who wants
   a newer number presses a button.

   Disable it while the refresh is in flight so a rapid double-press does not
   queue two navigations.

7. **Handle the empty building** — nobody in the building is the normal state
   most of the day. Render an `EmptyState` saying so, and make it read as a
   calm fact rather than an error or missing data.

   **Render `0` rather than blank** anywhere a count appears; an absent number
   reads as a broken page.

8. **Do not add any mutation control**, and do not link to check-in as a
   primary action — this is a status board, and WS-06 is the way into check-in.

9. **Update `nav-config.test.ts`**: remove `/staff/occupancy` from the
   placeholder brief and add `staff${sep}occupancy${sep}` to the data-access
   allowlist.

10. **Run all four scripts** for both packages.

## Tests

Component tests with Vitest; `@keki/staff-ops` mocked at the module boundary.

1. **The total headcount renders** — Mock `totalHeadcount: 7`; assert `7`
   appears. **This is SC-15.**
2. **A line renders per in-progress occurrence** — Mock two lines; assert both
   class names and headcounts appear.
3. **The lines sum to the total** — Mock lines of `4` and `3` with
   `totalHeadcount: 7`; assert all three numbers render, so a mismatch between
   the query's total and its lines would be visible rather than hidden.
4. **Each line shows when its class ends** — Assert the end time appears, since
   that is when those people stop counting.
5. **End times render in the cafe timezone** — Mock a UTC instant on the
   previous local day; assert the local time.
6. **The as-of time renders** — Assert `snapshot.asOf` appears, so a stale tab
   is self-evident. **SC-15.**
7. **The page states that there is no check-out** — Assert the copy mentions
   that people who leave early still count, so the number is trusted correctly
   rather than over-trusted.
8. **The page states the count covers classes that have not ended** — Assert
   the scoping is described.
9. **An empty building renders an empty state** — Mock `totalHeadcount: 0` with
   no lines; assert the empty state rather than a bare heading.
10. **An empty building does not render as an error** — Assert no error or
    failure wording appears; nobody in the building is the normal state.
11. **A zero headcount renders `0`, not blank** — Mock a line with
    `headcount: 0`; assert `0` appears, since an absent number reads as broken.
12. **The refresh control is rendered** — Assert it exists, since it is the
    entire freshness mechanism.
13. **Refresh calls `router.refresh()`** — Assert it is invoked on press.
14. **Refresh disables while in flight** — Assert disabled during the
    transition, so a double-press does not queue two navigations.
15. **No mutation control is rendered** — Assert there is no check-in, undo, or
    no-show control, since this surface is read-only.
16. **The page is dynamic, not cached** — Assert the module exports
    `dynamic = 'force-dynamic'` (or equivalent), since a cached occupancy count
    is confidently wrong.

## Acceptance Criteria

1. `apps/web` and `packages/ui` pass all four scripts.
2. `/staff/occupancy` renders the total headcount and a per-class breakdown of
   in-progress occurrences, and no longer renders `PlaceholderPanel`
   (tests 1–4). **SC-15.**
3. Each line shows when its class ends, in the cafe's timezone (tests 4–5).
4. The as-of time is stated (test 6). **SC-15.**
5. The page states plainly that there is no check-out and that the count covers
   classes that have not yet ended (tests 7–8).
6. An empty building renders a calm empty state, and a zero count renders `0`
   rather than blank (tests 9–11).
7. A refresh control exists, calls `router.refresh()`, and disables while in
   flight — no polling or streaming is added (tests 12–14).
8. No mutation control is added (test 15).
9. The page is dynamic (test 16).
10. `nav-config.test.ts` no longer treats `/staff/occupancy` as a placeholder.
