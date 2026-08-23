# WS-06: `/staff/today` — today's occurrences with expected and arrived counts

## Goal

Replace the `/staff/today` placeholder with the screen a staff member opens
when they arrive: what is running today, when, and how many of the expected
people have shown up.

This is the entry point to the staff surface. It answers "what am I doing
today" and routes to the check-in page for each class, so it should read at a
glance from across a counter rather than reward careful study.

## Traceability

- **SC-01** — `/staff/today` lists today's occurrences with start time, class
  name, and expected-versus-arrived counts.
- **SC-02** — Partially: renders the day and times in the cafe's timezone.
  WS-04 supplies the boundaries.

## Dependencies

- **WS-05** — Staff Server Actions (and, through them, WS-04's queries).

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Auth" and "Module boundaries"; `packages/ui` is
  presentational and consumed only by `apps/web`
- `docs/vision.md` — "Target Users"; the Front of house persona
- `apps/web/app/staff/today/page.tsx` — the placeholder being replaced
- `apps/web/app/staff/layout.tsx` — the existing `requireRole('FRONT_OF_HOUSE')`
  and the surface nav
- `apps/web/app/admin/schedules/page.tsx` — the Server Component + day-grouping
  pattern to follow, and how it renders occurrence times
- `packages/staff-ops/src/queries.ts` — WS-04's `listTodaysOccurrences`
- `packages/contracts/src/entities.ts` — `CAFE_TIME_ZONE`
- `packages/ui/src/components/status-badge.tsx` — Phase 3's badge
- `packages/ui/src/components/empty-state.tsx` — the empty state
- `packages/ui/src/components/index.ts` — the barrel
- `apps/web/app/nav-config.test.ts` — the placeholder brief and allowlist

## Package

`apps/web` and `packages/ui`

## Files Touched

- `apps/web/app/staff/today/page.tsx` (MODIFY — replace the placeholder)
- `apps/web/app/staff/today/occurrence-card.tsx` (NEW)
- `apps/web/app/staff/today/page.test.tsx` (NEW)
- `packages/ui/src/components/count-meter.tsx` (NEW — arrived-of-expected)
- `packages/ui/src/components/count-meter.test.tsx` (NEW)
- `packages/ui/src/components/index.ts` (MODIFY — barrel)
- `apps/web/app/nav-config.test.ts` (MODIFY — today is no longer a placeholder)

## Existing Interfaces to Consume

The placeholder being replaced, in full:

```tsx
import { PageShell, PlaceholderPanel } from '@keki/ui';

export default function StaffTodayPage() {
  return (
    <PageShell title="Today" description="Staff view of today's schedule.">
      <PlaceholderPanel title="Today's schedule" plannedFor="Phase 2" />
    </PageShell>
  );
}
```

WS-04's read, which already excludes cancelled occurrences and tomorrow's:

```ts
export interface StaffOccurrenceView {
  readonly occurrenceId: OccurrenceId;
  readonly offeringName: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly capacity: number;
  readonly expectedParticipants: number;
  readonly arrivedParticipants: number;
  readonly status: OccurrenceStatus;
}

export async function listTodaysOccurrences(input?: {
  now?: Date;
}): Promise<readonly StaffOccurrenceView[]>;
```

The timezone constant, relocated by WS-01 so every surface renders the same
class at the same local hour:

```ts
export const CAFE_TIME_ZONE = 'America/Los_Angeles';
```

## Implementation Steps

1. **Build the page** in `page.tsx` as a Server Component calling
   `listTodaysOccurrences()`. Render the cafe's local date as a heading so
   there is no ambiguity about which day is shown — a staff member opening this
   at 11pm should see which date they are looking at.

   Times render in `CAFE_TIME_ZONE`, imported from `@keki/contracts`. **Do not
   declare a second constant**; WS-01 relocated it precisely so every surface
   shares one.

2. **Build the occurrence card** in `occurrence-card.tsx` as a Server
   Component. Per occurrence show: start and end time, class name,
   `arrived / expected`, and a link to `/staff/check-in?occurrenceId=...`.

   The card is the primary control — the whole point of this screen is getting
   to check-in for the class in front of you — so make the whole card the link
   target rather than a small "check in" affordance.

3. **Add `CountMeter`** to `packages/ui`: a small presentational component
   taking `arrived` and `expected` and rendering `arrived / expected` with a
   visual fill. Presentational only — it must not know what a reservation is,
   so the occupancy surface can reuse it.

   **Handle `expected === 0`** without dividing by zero. A class with no
   bookings is ordinary, especially early in the day.

4. **Mark the in-progress occurrence.** An occurrence where
   `startsAt <= now < endsAt` is the one happening right now, and it is what a
   staff member is looking for. Distinguish it visibly and sort it into place
   chronologically rather than pinning it — the list is short and reordering
   would make the screen move under someone's hand.

5. **Distinguish "everyone here" from "nobody yet".** When
   `arrived === expected` and `expected > 0`, say so plainly. That is the state
   a staff member is trying to reach, and reading two equal numbers is slower
   than reading a word.

6. **Handle the empty day** — a day with no classes is ordinary, especially on
   a quiet weekday. Render an `EmptyState` saying there is nothing scheduled
   today rather than an empty page under a heading.

7. **Do not add any mutation control.** Check-in belongs to WS-07. A control
   here would need a participant, and this page does not load them.

8. **Update `nav-config.test.ts`**: remove `/staff/today` from the placeholder
   brief and add `staff${sep}today${sep}` to the data-access allowlist.

9. **Run all four scripts** for both packages.

## Tests

Component tests with Vitest; `@keki/staff-ops` mocked at the module boundary.

1. **Occurrences render in ascending time order** — Mock three out of order;
   assert the rendered order is chronological. **This is SC-01.**
2. **Each card shows the class name and time range** — Assert both appear.
3. **Times render in the cafe timezone** — Mock a UTC instant falling on the
   previous local day; assert the local time renders, proving the constant is
   applied rather than the server's zone. **SC-02.**
4. **The page imports `CAFE_TIME_ZONE` from `@keki/contracts`** — Assert the
   module does not declare its own constant, so the surfaces cannot drift.
5. **`arrived / expected` renders** — Mock `arrivedParticipants: 2`,
   `expectedParticipants: 5`; assert `2` and `5` both appear.
6. **A card links to check-in for its occurrence** — Assert the href carries
   that occurrence's id, so the card routes to the right roster.
7. **The in-progress occurrence is marked** — Mock one spanning `now`; assert
   it is distinguished from one later in the day.
8. **A not-yet-started occurrence is not marked** — Assert the marker is
   absent, so it carries signal.
9. **A finished occurrence is not marked as in progress** — Mock one whose
   `endsAt` has passed; assert absent.
10. **"Everyone here" renders when arrived equals expected** — Mock `3` and
    `3`; assert the plain-language state appears.
11. **It does not render when expected is zero** — Mock `0` and `0`; assert the
    "everyone here" wording is **absent**, since nobody was expected and
    claiming completeness would be misleading.
12. **A partially arrived class does not claim completeness** — Mock `2` of
    `5`; assert absent.
13. **An empty day renders an empty state** — Mock `[]`; assert the empty state
    rather than a bare heading.
14. **The cafe's local date renders as a heading** — Assert the date appears,
    so a staff member knows which day they are seeing.
15. **`CountMeter` renders both numbers** — Assert `2` and `5` appear.
16. **`CountMeter` handles `expected === 0` without dividing by zero** — Assert
    it renders and produces no `NaN` or `Infinity` in the output.
17. **`CountMeter` at zero arrived renders `0`, not blank** — Assert `0`
    appears, since an absent number reads as missing data.
18. **No mutation control is rendered** — Assert there is no check-in or
    no-show control, since this page loads no participants.
19. **`packages/ui` imports no data layer** — Assert its `package.json`
    declares neither `@keki/staff-ops` nor `@keki/database`.

## Acceptance Criteria

1. `apps/web` and `packages/ui` pass all four scripts.
2. `/staff/today` lists today's occurrences in time order with class name, time
   range, and `arrived / expected`, and no longer renders `PlaceholderPanel`
   (tests 1–2, 5). **SC-01.**
3. Times and the day heading render in the cafe's timezone using the constant
   from `@keki/contracts`, not a local copy (tests 3–4, 14). **SC-02.**
4. Each card links to `/staff/check-in` for its own occurrence (test 6).
5. The in-progress occurrence is visibly distinguished, and neither future nor
   finished ones are (tests 7–9).
6. "Everyone here" appears only when `expected > 0` and all have arrived
   (tests 10–12).
7. An empty day renders an empty state (test 13).
8. `CountMeter` is presentational, survives `expected === 0`, and renders a
   literal `0` rather than blank (tests 15–17, 19).
9. No mutation control is added (test 18).
10. `nav-config.test.ts` no longer treats `/staff/today` as a placeholder.
