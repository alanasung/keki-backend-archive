# WS-03: catalog-admin — occurrence scheduling, edit, and cancellation

## Goal

Give staff the ability to put a published class on the calendar: schedule a
dated occurrence, edit its time or capacity, and cancel it.

This is the workstream that makes a class actually appear on `/book`. It looks
like three inserts and is not — `ends_at` is derived from the offering rather
than supplied, past dates and overlaps are refused, capacity edits interact
with a live capacity trigger and with reservations that may already exist, and
cancellation is restricted because refunds do not exist yet.

## Traceability

- **SC-04** — A manager can schedule an occurrence for a published offering,
  and `ends_at` is derived from the offering's duration.
- **SC-05** — Scheduling an occurrence in the past is refused with a clear
  message.
- **SC-06** — Two overlapping occurrences of the same offering are refused.
- **SC-08** — Lowering capacity below the booked count succeeds and reports the
  booked count. WS-06/WS-07 surface the warning; this supplies it.
- **SC-09** — Cancelling an unbooked occurrence succeeds; cancelling one with
  confirmed reservations is refused and states why.

## Dependencies

- **WS-01** — Contracts (occurrence schemas, occurrence transitions).
- **WS-02** — catalog-admin (the package, its errors, and offering reads).

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Data access"; all access goes through `packages/database`
- `docs/vision.md` — "Core Concepts"; Occurrence and Reservation
- `packages/database/src/schema/catalog.ts` — the `occurrences` table and its
  `timestamptz` comment
- `packages/database/src/schema/reservations.ts` — `seat_count` and the
  statuses that consume a seat
- `packages/database/drizzle/0002_capacity_constraint.sql` — the capacity
  trigger, its `FOR UPDATE` lock, and `SQLSTATE 'KEKI1'`
- `packages/catalog-core/src/queries.ts` — `listBookableOfferings` and how
  `seatsRemaining` is computed and clamped
- `packages/reservation-core/src/queries.ts` — the reservation reads and the
  seat-consuming status set
- `packages/contracts/src/admin.ts` — WS-01's occurrence schemas
- `packages/catalog-admin/src/offerings.ts` — WS-02's offering reads

## Package

`packages/catalog-admin`

## Files Touched

- `packages/catalog-admin/src/occurrences.ts` (NEW)
- `packages/catalog-admin/src/queries.ts` (MODIFY — occurrence reads with booked counts)
- `packages/catalog-admin/src/errors.ts` (MODIFY — occurrence errors)
- `packages/catalog-admin/src/index.ts` (MODIFY — barrel)
- `packages/catalog-admin/src/occurrences.test.ts` (NEW)
- `packages/catalog-admin/src/occurrence-capacity.test.ts` (NEW)

## Existing Interfaces to Consume

The `occurrences` table. Note `endsAt` is `notNull` — the command must supply
it, which is why it is derived rather than optional:

```ts
export const occurrences = pgTable('occurrences', {
  id: uuid('id').primaryKey().defaultRandom(),
  offeringId: uuid('offering_id').notNull().references(() => offerings.id),
  // Always timestamptz — a cafe with scheduled programming across DST
  // boundaries will produce wrong answers with a bare timestamp.
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  capacityOverride: integer('capacity_override'),
  status: occurrenceStatusEnum('status').notNull().default('SCHEDULED'),
});
```

The capacity contract this must respect, from the WS-02 trigger of the
previous program:

- Effective capacity is `coalesce(occurrences.capacity_override,
  offerings.default_capacity)`.
- Statuses `HELD`, `CONFIRMED`, `CHECKED_IN` consume seats; `CANCELLED` and
  `NO_SHOW` do not.
- Exceeding capacity on a `reservations` insert or update raises
  `SQLSTATE 'KEKI1'`.

> The trigger guards `reservations`, not `occurrences`. Lowering
> `capacity_override` therefore cannot be refused by the database, which is
> precisely why over-subscription is reachable and why `seatsRemaining` clamps.

How `catalog-core` computes remaining seats — the admin count must agree with
it, or the two surfaces will disagree about the same class:

```ts
// seatsRemaining = coalesce(capacity_override, default_capacity)
//                  - coalesce(sum(seat_count) where status in
//                    ('HELD','CONFIRMED','CHECKED_IN'), 0)
// clamped at zero
export async function listBookableOfferings(input?: {
  from?: Date;
  to?: Date;
  types?: readonly OfferingType[];
}): Promise<readonly BookableOccurrenceView[]>;
```

WS-01's schemas, which omit `endsAt` deliberately:

```ts
export const scheduleOccurrenceSchema = z.object({
  offeringId: z.string().uuid(),
  startsAt: z.coerce.date(),
  capacityOverride: z.number().int().min(1).max(500).nullable(),
}).strict();
```

## Implementation Steps

1. **Add typed errors** to `errors.ts`: `OccurrenceNotFoundError`,
   `OfferingNotPublishedError`, `OccurrenceInPastError`,
   `OverlappingOccurrenceError` (carrying the conflicting occurrence's id and
   start), `OccurrenceHasReservationsError` (carrying the confirmed count), and
   `InvalidOccurrenceTransitionError`.

   `OccurrenceHasReservationsError` carries the count because the UI must tell
   a manager *why* they cannot cancel — "3 people are booked" is actionable,
   "cannot cancel" is not.

2. **Implement `scheduleOccurrence`** in `occurrences.ts`:

   ```ts
   export async function scheduleOccurrence(input: {
     data: ScheduleOccurrenceInput;
     actorCustomerId: CustomerId;
     now?: Date;
     tx?: Tx;
   }): Promise<Occurrence>;
   ```

   In one transaction, in this order:

   a. Load the offering. Throw `OfferingNotFoundError` if absent, and
      `OfferingNotPublishedError` unless its status is `PUBLISHED`.

      Scheduling a draft is refused because the occurrence would be invisible:
      `listBookableOfferings` filters to published offerings, so the manager
      would see nothing on `/book` and reasonably conclude the scheduling
      failed. Refusing with a reason is kinder than succeeding invisibly.

   b. Reject a `startsAt` at or before `now` with `OccurrenceInPastError`. Same
      reasoning — `/book` filters to future occurrences, so a past one is
      created and then invisible.

   c. Compute `endsAt` as `startsAt + offering.durationMinutes` minutes. Never
      accept it as input; two sources for the same span drift.

   d. Reject an overlap with another non-`CANCELLED` occurrence **of the same
      offering** — any existing row where `startsAt < newEndsAt` and
      `endsAt > newStartsAt`.

      Scoped to the offering, not globally: two *different* classes may
      legitimately run at once in different rooms. This is deliberately a
      command-level check rather than a database constraint, because the rule
      is per offering and Postgres exclusion constraints over a range would
      need a schema change this program does not otherwise require.

   e. Insert with `status: 'SCHEDULED'`.

   Accept an optional `tx` so WS-04 composes the audit write into the same
   transaction.

3. **Implement `updateOccurrence`**:

   ```ts
   export async function updateOccurrence(input: {
     occurrenceId: OccurrenceId;
     data: UpdateOccurrenceInput;
     actorCustomerId: CustomerId;
     now?: Date;
     tx?: Tx;
   }): Promise<{ before: Occurrence; after: Occurrence; bookedSeats: number }>;
   ```

   Recompute `endsAt` whenever `startsAt` changes, from the offering's current
   duration. Re-apply the past-date and overlap checks, excluding the row being
   updated from the overlap query — otherwise every occurrence conflicts with
   itself.

   **Permit lowering `capacityOverride` below the booked count**, and return
   `bookedSeats` so the caller can warn. Do not refuse it: the constraint is
   physical — a room got smaller — and refusing leaves staff unable to record
   reality. The customer surface is already safe, because `seatsRemaining`
   clamps at zero and renders "sold out".

   Compute `bookedSeats` as the sum of `seat_count` over reservations for this
   occurrence whose status is in `('HELD','CONFIRMED','CHECKED_IN')` — **the
   same status set the capacity trigger counts and `catalog-core` subtracts**.
   If these three ever disagree, one surface advertises seats another refuses.

   Refuse edits to a `CANCELLED` occurrence.

4. **Implement `cancelOccurrence`**:

   ```ts
   export async function cancelOccurrence(input: {
     occurrenceId: OccurrenceId;
     actorCustomerId: CustomerId;
     tx?: Tx;
   }): Promise<{ occurrence: Occurrence; changed: boolean }>;
   ```

   Count reservations in `('CONFIRMED','CHECKED_IN')` for the occurrence. If
   any exist, throw `OccurrenceHasReservationsError` with the count.

   Confirmed seats block cancellation because refunds do not exist —
   `PAID` is terminal in the order state machine and `refundPayment` is still a
   stub — so cancelling a class people paid for would leave money owed with no
   tracked path. Refusing is the honest state until refunds are built.

   `HELD` seats do **not** block. A hold is an in-progress checkout that
   expires on its own within fifteen minutes; treating it as a booking would
   let one abandoned cart block a manager indefinitely.

   Perform the write as a single conditional UPDATE guarded on
   `status = 'SCHEDULED'`, returning `changed: false` when already cancelled.

5. **Add occurrence queries** to `queries.ts`:

   ```ts
   export async function listUpcomingOccurrences(input?: {
     from?: Date;
     limit?: number;
   }): Promise<readonly AdminOccurrenceView[]>;
   ```

   Returning, per occurrence: the offering name, start and end, effective
   capacity, `bookedSeats`, and status. Include occurrences of **draft and
   archived** offerings — a manager needs to see what is scheduled against an
   unpublished class, which is exactly the state `/book` hides.

   Compute booked counts in one aggregate query with a `LEFT JOIN`, not N+1
   per occurrence.

6. **Run all four scripts** and `pnpm -r typecheck`.

## Tests

All database tests are `describe.skipIf(!hasLiveDatabase)`, isolated by
per-test `crypto.randomUUID()` identifiers rather than truncation, so this
suite cannot disturb others sharing the CI branch.

1. **`scheduleOccurrence` derives endsAt from duration** _(integration)_ —
   Offering with `durationMinutes: 90`, start at 10:00; assert `endsAt` is
   11:30 exactly. **This is SC-04.**
2. **`scheduleOccurrence` rejects a supplied endsAt** _(integration)_ — Assert
   an input carrying `endsAt` fails at parse and inserts nothing.
3. **`scheduleOccurrence` refuses an unpublished offering** _(integration)_ —
   Assert `OfferingNotPublishedError` for a `DRAFT` offering and no row
   inserted.
4. **`scheduleOccurrence` refuses a past start** _(integration)_ — Pass a
   `startsAt` one minute before `now`; assert `OccurrenceInPastError`. **This
   is SC-05.**
5. **`scheduleOccurrence` accepts a start moments in the future** — Assert one
   minute ahead succeeds, proving the boundary is not off by an interval.
6. **`scheduleOccurrence` refuses an exact overlap** _(integration)_ — Two
   occurrences of one offering at the same time; assert
   `OverlappingOccurrenceError`. **This is SC-06.**
7. **`scheduleOccurrence` refuses a partial overlap** _(integration)_ — An
   occurrence starting inside another's span; assert refusal in both
   directions (new-inside-existing, existing-inside-new).
8. **Adjacent occurrences are permitted** _(integration)_ — One ending exactly
   when the next begins; assert success. A back-to-back class is normal, and
   an off-by-one comparison would refuse it.
9. **Overlap is scoped to the offering** _(integration)_ — Two *different*
   offerings at the same time; assert both succeed.
10. **A cancelled occurrence does not block a new one** _(integration)_ —
    Cancel, then schedule at the same time; assert success.
11. **`updateOccurrence` recomputes endsAt when the start moves**
    _(integration)_ — Move the start by an hour; assert `endsAt` moves by
    exactly an hour.
12. **`updateOccurrence` excludes itself from the overlap check**
    _(integration)_ — Edit an occurrence's capacity without moving it; assert
    it does not conflict with itself.
13. **Lowering capacity below bookings succeeds and reports the count**
    _(integration)_ — Capacity 8 with 3 seats booked, lower to 2; assert the
    call succeeds and `bookedSeats` is 3. **This is SC-08.**
14. **After that edit the customer page shows zero, not negative**
    _(integration)_ — Call `listBookableOfferings`; assert `seatsRemaining` is
    `0`. This is the assertion that proves the clamp holds under an admin edit,
    not merely in principle.
15. **`bookedSeats` counts the trigger's status set** _(integration)_ — Seed
    one `HELD`, one `CONFIRMED`, one `CANCELLED`, one `NO_SHOW`; assert
    `bookedSeats` counts only the first two.
16. **`bookedSeats` sums seat_count, not rows** _(integration)_ — One
    reservation with `seat_count: 3`; assert `3`, not `1`.
17. **`updateOccurrence` refuses a cancelled occurrence** _(integration)_ —
    Assert it throws and the row is unchanged.
18. **`cancelOccurrence` succeeds when unbooked** _(integration)_ — Assert
    status becomes `'CANCELLED'` and `changed` is `true`. **This is SC-09.**
19. **`cancelOccurrence` refuses confirmed reservations** _(integration)_ —
    Seed two `CONFIRMED`; assert `OccurrenceHasReservationsError` carrying the
    count `2`, and the occurrence still `SCHEDULED`.
20. **A held seat does not block cancellation** _(integration)_ — Seed one
    `HELD`; assert cancellation succeeds, since a hold expires on its own.
21. **A cancelled reservation does not block cancellation** _(integration)_ —
    Seed one `CANCELLED`; assert success.
22. **`cancelOccurrence` is idempotent** _(integration)_ — Cancel twice; assert
    the second returns `changed: false` without throwing.
23. **A cancelled occurrence disappears from `/book`** _(integration)_ — Cancel
    a scheduled occurrence; assert `listBookableOfferings` no longer returns
    it.
24. **`listUpcomingOccurrences` includes unpublished offerings**
    _(integration)_ — Schedule against a published offering, then unpublish it;
    assert the occurrence still appears in the admin list though it is gone
    from `/book`.
25. **`listUpcomingOccurrences` is not N+1** _(integration)_ — Seed 20
    occurrences; assert the query count is constant by spying on the db client.

## Acceptance Criteria

1. `packages/catalog-admin` passes all four scripts, and `pnpm -r typecheck`
   passes workspace-wide.
2. `endsAt` is always derived from the offering's `durationMinutes` and is
   unrepresentable as input (tests 1–2, 11). **SC-04.**
3. Scheduling refuses unpublished offerings and past starts, each with a
   distinct typed error (tests 3–5). **SC-05.**
4. Overlaps are refused, scoped to the offering, with adjacency permitted and
   cancelled occurrences ignored (tests 6–10). **SC-06.**
5. Lowering capacity below bookings succeeds, returns `bookedSeats`, and leaves
   `/book` showing zero rather than a negative count (tests 13–14). **SC-08.**
6. `bookedSeats` counts exactly the statuses the capacity trigger counts and
   sums `seat_count` rather than rows (tests 15–16).
7. Cancellation succeeds when unbooked and is refused for confirmed
   reservations with the count attached; held and cancelled reservations do not
   block (tests 18–22). **SC-09.**
8. A cancelled occurrence stops appearing on `/book` (test 23).
9. `listUpcomingOccurrences` shows occurrences of unpublished offerings and
   runs as a single aggregate query (tests 24–25).
10. Every command accepts an optional `tx` so WS-04 can compose its audit write
    into the same transaction.
11. No command depends on `refundPayment` or any refund behavior.
