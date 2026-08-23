# WS-04: `staff-ops` — today's schedule, roster, and occupancy queries

## Goal

Give the staff surfaces their reads: what is running today, who is expected on
a given occurrence, and who is in the building right now.

All three are aggregate queries over data that already exists. The hard parts
are not the SQL: "today" must mean the cafe's calendar day rather than the
server's or a rolling 24 hours, the roster must resolve participant *names*
from two different tables, and occupancy must be honest about the fact that
there is no check-out.

No writes. WS-03 owns those.

## Traceability

- **SC-01** — Partially: supplies today's occurrences with expected and arrived
  counts. WS-06 renders them.
- **SC-02** — "Today" is computed in the cafe's timezone, not the server's, and
  not as a rolling 24 hours.
- **SC-14** — Partially: supplies the roster with participant names and
  check-in state. WS-07 renders it.
- **SC-15** — Partially: supplies current occupancy, excluding ended
  occurrences. WS-08 renders it.

## Dependencies

- **WS-01** — Contracts (`CAFE_TIME_ZONE`).

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Data access"; all access goes through `packages/database`
- `docs/vision.md` — "Target Users"; Front of house needs today's schedule,
  check-in, and occupancy
- `packages/database/src/schema/reservations.ts` — `reservations` and
  `reservation_participants`, including `checked_in_at`
- `packages/database/src/schema/catalog.ts` — `occurrences` and `offerings`,
  and the `timestamptz` comment explaining why times are stored with a zone
- `packages/database/src/schema/customers.ts` — `customers` and `children`,
  where participant names live
- `packages/catalog-admin/src/queries.ts` — `listUpcomingOccurrences` and its
  single-aggregate `bookedSeats` expression, the pattern to mirror
- `packages/catalog-core/src/queries.ts` — how `seatsRemaining` is computed and
  which statuses it subtracts
- `packages/contracts/src/entities.ts` — `SEAT_CONSUMING_STATUSES`,
  `CAFE_TIME_ZONE` (relocated by WS-01), `ReservationStatus`
- `apps/web/app/admin/reservations/occurrence-roster.tsx` — how the admin
  roster resolves participant names today, and the `'Unknown participant'`
  and no-participants fallbacks it already handles

## Package

`packages/staff-ops`

## Files Touched

- `packages/staff-ops/src/queries.ts` (NEW)
- `packages/staff-ops/src/day-boundaries.ts` (NEW — cafe-timezone day math)
- `packages/staff-ops/src/index.ts` (MODIFY — barrel)
- `packages/staff-ops/src/queries.test.ts` (NEW)
- `packages/staff-ops/src/day-boundaries.test.ts` (NEW)

## Existing Interfaces to Consume

The occurrences table. `starts_at`/`ends_at` are `timestamptz` precisely so a
business crossing DST does not answer wrongly twice a year:

```ts
export const occurrences = pgTable('occurrences', {
  id: uuid('id').primaryKey().defaultRandom(),
  offeringId: uuid('offering_id').notNull().references(() => offerings.id),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  capacityOverride: integer('capacity_override'),
  status: occurrenceStatusEnum('status').notNull().default('SCHEDULED'),
});
```

The admin query whose aggregate shape this mirrors — one `LEFT JOIN` with a
conditional sum, not N+1:

```ts
const bookedSeats = sql<number>`coalesce(sum(case when ${reservations.status} in ${SEAT_CONSUMING_STATUSES} then ${reservations.seatCount} else 0 end), 0)::int`;

export async function listUpcomingOccurrences(input?: {
  from?: Date;
  limit?: number;
}): Promise<readonly AdminOccurrenceView[]>;
```

The relocated timezone constant:

```ts
export const CAFE_TIME_ZONE = 'America/Los_Angeles';
```

The seat-consuming set, which `expectedParticipants` must agree with:

```ts
export const SEAT_CONSUMING_STATUSES = ['HELD', 'CONFIRMED', 'CHECKED_IN'] as const;
```

## Implementation Steps

1. **Write the day-boundary helper** in `day-boundaries.ts`:

   ```ts
   export function cafeDayBounds(now: Date): { start: Date; end: Date };
   ```

   Returns the UTC instants bracketing the cafe's calendar day containing
   `now`, computed against `CAFE_TIME_ZONE`.

   Derive the local calendar date with `Intl.DateTimeFormat` using
   `timeZone: CAFE_TIME_ZONE` — the same mechanism `class-listing.tsx` already
   uses for day grouping — then resolve that local midnight back to a UTC
   instant. **Do not** subtract a fixed offset: the offset changes twice a year
   and a hardcoded one is wrong for half the year.

   This is a pure function taking `now`, so it is testable without a database
   and without mocking the clock.

2. **Implement `listTodaysOccurrences`** in `queries.ts`:

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

   Select occurrences whose `starts_at` falls inside `cafeDayBounds(now)`,
   ordered ascending.

   - `expectedParticipants` counts participants on reservations whose status is
     in `SEAT_CONSUMING_STATUSES` — the same set the capacity trigger counts, so
     the staff view cannot disagree with `/admin/schedules` about the same class.
   - `arrivedParticipants` counts those same participants with `checked_in_at`
     not null.

   Compute both in **one** aggregate query with conditional sums. A count per
   occurrence is N+1 and will be the first thing to hurt on a busy Saturday.

   **Exclude `CANCELLED` occurrences.** A cancelled class is not running today,
   and listing it invites staff to check people into it.

3. **Implement `listOccurrenceRoster`**:

   ```ts
   export interface RosterParticipantView {
     readonly participantId: ReservationParticipantId;
     readonly reservationId: ReservationId;
     readonly displayName: string;
     readonly isChild: boolean;
     readonly checkedInAt: Date | null;
     readonly reservationStatus: ReservationStatus;
   }

   export async function listOccurrenceRoster(
     occurrenceId: OccurrenceId,
   ): Promise<readonly RosterParticipantView[]>;
   ```

   Resolve names by joining `customers` and `children` directly — a participant
   row carries exactly one of `customer_id` or `child_id`, so a single query
   with two `LEFT JOIN`s and a `coalesce` on the name gets every row in one
   pass.

   Render `'Unknown participant'` when neither join resolves. A child removed
   from a household after booking is a real state, and a roster that throws is
   useless exactly when someone needs it.

   Order **checked-in last**: staff work down a list of people who have not
   arrived yet, so the un-arrived belong at the top where the work is.

   Include only reservations in `SEAT_CONSUMING_STATUSES`. A `CANCELLED`
   booking is not expected, and — as the Phase 3 admin roster demonstrated —
   listing cancelled rows produces a page of noise.

4. **Implement `getCurrentOccupancy`**:

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

   Count participants with `checked_in_at` not null, on `SCHEDULED` occurrences
   where `starts_at <= now AND ends_at > now`.

   The `ends_at > now` bound is what makes this honest. **There is no
   `checked_out_at` column and this program does not add one**, so someone who
   leaves early still counts until their class ends. Scoping to in-progress
   occurrences means the number self-clears rather than growing all day.

   Return `asOf` so the surface can state when the snapshot was taken instead
   of implying it is live.

5. **Export from the barrel** and run all four scripts, then `pnpm -r typecheck`.

## Tests

Day-boundary tests are pure and run without a database. Query tests are
`describe.skipIf(!hasLiveDatabase)` under a suite named
`integration: staff-ops queries`, isolated by per-test `crypto.randomUUID()`.

1. **`cafeDayBounds` brackets the local calendar day** — For an instant at
   14:00 local, assert `start` is local midnight and `end` is the next local
   midnight, expressed as UTC instants.
2. **A UTC instant belonging to the previous local day maps correctly** — Pass
   `2026-08-22T04:00:00Z`, which is 21:00 on 2026-08-21 in
   `America/Los_Angeles`; assert the bounds are **August 21's**, not August
   22's. **This is SC-02**, and the case a server-timezone implementation gets
   wrong every evening.
3. **`cafeDayBounds` is correct across the spring DST boundary** — Pass an
   instant on the US spring-forward date; assert the day is 23 hours long, not
   24. A fixed-offset implementation passes tests 1–2 and fails here.
4. **`cafeDayBounds` is correct across the autumn DST boundary** — Assert the
   day is 25 hours long.
5. **The bounds are half-open** — Assert an occurrence at exactly `end` is
   excluded and one at exactly `start` is included, so midnight classes are
   counted once rather than twice or never.
6. **`listTodaysOccurrences` returns today's occurrences ascending**
   _(integration)_ — Seed three at different times out of order; assert the
   order. **This is SC-01.**
7. **It excludes tomorrow's occurrences** _(integration)_ — Seed one just after
   the local day ends; assert it is absent. Not a rolling 24 hours.
8. **It excludes yesterday's** _(integration)_ — Assert absent.
9. **It excludes `CANCELLED` occurrences** _(integration)_ — Assert absent, so
   staff cannot check someone into a cancelled class.
10. **`expectedParticipants` counts seat-consuming reservations only**
    _(integration)_ — Seed one `CONFIRMED` (2 participants), one `HELD` (1),
    one `CANCELLED` (3); assert `expectedParticipants` is `3`, not `6`.
11. **`arrivedParticipants` counts only checked-in rows** _(integration)_ —
    Check in one of three; assert `arrivedParticipants` is `1` while
    `expectedParticipants` stays `3`.
12. **`arrivedParticipants` is zero before anyone arrives** _(integration)_ —
    Assert `0`, not null.
13. **The counts come from one query, not N+1** _(integration)_ — Seed 20
    occurrences; assert the query count is constant by spying on the db client.
14. **`listOccurrenceRoster` resolves a child's name** _(integration)_ — Assert
    the child's name renders and `isChild` is `true`.
15. **It resolves an adult customer's name** _(integration)_ — Assert both
    participant kinds work, since both are valid.
16. **An unresolvable participant yields `'Unknown participant'`**
    _(integration)_ — Assert the fallback and that the call does not throw.
17. **The roster orders un-arrived first** _(integration)_ — Check in one of
    three; assert the checked-in row sorts last, where staff are working down
    the un-arrived.
18. **The roster excludes cancelled reservations** _(integration)_ — Assert
    absent.
19. **The roster carries `checkedInAt` and reservation status per row**
    _(integration)_ — Assert both are populated, since the UI branches on them.
20. **`getCurrentOccupancy` counts checked-in participants of in-progress
    occurrences** _(integration)_ — One occurrence started 10 minutes ago
    ending in 50, two checked in of three; assert `totalHeadcount` is `2`.
    **This is SC-15.**
21. **It excludes an occurrence that has ended** _(integration)_ — Check
    someone into an occurrence whose `ends_at` is in the past; assert
    `totalHeadcount` is `0`. This is the bound that keeps occupancy from
    growing all day.
22. **It excludes an occurrence that has not started** _(integration)_ — Assert
    excluded.
23. **It excludes participants who are not checked in** _(integration)_ — Three
    expected, none arrived; assert `0`.
24. **It reports per-occurrence lines** _(integration)_ — Two in-progress
    occurrences; assert two lines whose headcounts sum to `totalHeadcount`.
25. **`asOf` reflects the supplied `now`** _(integration)_ — Assert it equals
    the passed instant, so the surface can state its own freshness honestly.
26. **An empty building returns zero and no lines** _(integration)_ — Assert
    `totalHeadcount` is `0` and `lines` is empty, not an error.

## Acceptance Criteria

1. `packages/staff-ops` passes all four scripts, and `pnpm -r typecheck` passes
   workspace-wide.
2. `cafeDayBounds` is a pure function of `now`, computes the cafe's calendar day
   from `CAFE_TIME_ZONE`, and is correct across both DST boundaries (tests 1–5).
   **SC-02.**
3. `listTodaysOccurrences` returns today's occurrences ascending, excluding
   yesterday, tomorrow, and cancelled ones (tests 6–9). **SC-01.**
4. `expectedParticipants` counts exactly the statuses the capacity trigger
   counts, so the staff view cannot disagree with `/admin/schedules` (test 10).
5. `arrivedParticipants` counts only participants with `checked_in_at` set
   (tests 11–12).
6. Both counts come from a single aggregate query (test 13).
7. `listOccurrenceRoster` resolves names for both participant kinds, falls back
   rather than throwing, and orders un-arrived first (tests 14–17). **SC-14.**
8. `getCurrentOccupancy` counts only checked-in participants of in-progress
   occurrences and excludes ended ones (tests 20–23). **SC-15.**
9. The snapshot carries `asOf` and per-occurrence lines that sum to the total
   (tests 24–25).
10. No write path is added in this workstream.
