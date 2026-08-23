# WS-03: `staff-ops` — check-in, undo, and no-show commands

## Goal

Create `packages/staff-ops` and give it the three write paths front of house
needs: check a participant in, undo that, and mark a reservation a no-show.

This is the workstream that makes `CHECKED_IN` reachable. It has been a
reservation status since Phase 1 and **no code has ever written it**;
`reservation_participants.checked_in_at` has never been set.

It looks like stamping a timestamp and is not: the participant timestamp is the
source of truth and the reservation status is a **roll-up** derived from it
inside the same transaction, check-in must be idempotent under a double-tap on
a busy morning, and undo has to decide correctly whether any participant
remains before reverting.

## Traceability

- **SC-03** — Staff can check in an individual participant, setting
  `reservation_participants.checked_in_at`.
- **SC-04** — Checking in the first participant moves the reservation
  `CONFIRMED → CHECKED_IN`.
- **SC-05** — Undoing clears the timestamp, and the reservation returns to
  `CONFIRMED` only when no participant remains checked in.
- **SC-06** — Check-in is idempotent.
- **SC-07** — Checking in a `HELD` reservation is refused.
- **SC-08** — Staff can mark a reservation `NO_SHOW` and its seats are released.
- **SC-09** — An undeclared reservation transition is refused.
- **SC-10** — Every staff mutation writes a `staff_audit_log` row.
- **SC-11** — An audit entry never survives a rolled-back staff mutation.
- **SC-16** — Checking in does not change the occurrence's seat count.

## Dependencies

- **WS-01** — Contracts (`RESERVATION_TRANSITIONS`, check-in schemas, staff
  audit actions).
- **WS-02** — `recordAuditEntry` relocated to `packages/database`.

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Module boundaries" and "Data access"; `packages/*-core` are
  plain TypeScript libraries, and every package defines all four scripts
- `docs/vision.md` — "Target Users"; the Front of house persona
- `packages/database/src/schema/reservations.ts` — the `reservations` and
  `reservation_participants` columns, including `checked_in_at`
- `packages/database/drizzle/0002_capacity_constraint.sql` — the capacity
  trigger, which statuses consume a seat, and `SQLSTATE 'KEKI1'`
- `packages/database/src/transaction.ts` — `withTransaction` and `Tx`
- `packages/database/src/audit.ts` — WS-02's relocated `recordAuditEntry`
- `packages/contracts/src/staff.ts` — WS-01's transitions and schemas
- `packages/catalog-admin/src/occurrences.ts` — the command shape to mirror:
  optional `tx`, typed errors, audit inside the transaction
- `packages/catalog-admin/src/errors.ts` — the typed-error style
- `packages/catalog-admin/package.json` — the package manifest to copy
- `packages/catalog-admin/src/package-boundaries.test.ts` — the boundary test
  to mirror
- `packages/reservation-core/src/commands.ts` — how the existing reservation
  lifecycle writes, and the `KEKI1` cause-chain handling
- `vitest.workspace.ts` — where the new package must be registered

## Package

`packages/staff-ops` (NEW)

## Files Touched

- `packages/staff-ops/package.json` (NEW)
- `packages/staff-ops/tsconfig.json` (NEW)
- `packages/staff-ops/eslint.config.mjs` (NEW)
- `packages/staff-ops/src/index.ts` (NEW — barrel)
- `packages/staff-ops/src/errors.ts` (NEW)
- `packages/staff-ops/src/check-in.ts` (NEW — the three commands)
- `packages/staff-ops/src/check-in.test.ts` (NEW)
- `packages/staff-ops/src/package-boundaries.test.ts` (NEW)
- `vitest.workspace.ts` (MODIFY — register the package)

## Existing Interfaces to Consume

The two tables. Note `checked_in_at` is nullable and has never been written,
and that `reservation_participants` cascades from `reservations`:

```ts
export const reservationParticipants = pgTable('reservation_participants', {
  id: uuid('id').primaryKey().defaultRandom(),
  reservationId: uuid('reservation_id').notNull()
    .references(() => reservations.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').references(() => customers.id),
  childId: uuid('child_id').references(() => children.id),
  waiverRecordId: uuid('waiver_record_id').references(() => waiverRecords.id),
  checkedInAt: timestamp('checked_in_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

The capacity contract this must respect:

- Effective capacity is `coalesce(occurrences.capacity_override, offerings.default_capacity)`.
- Statuses `HELD`, `CONFIRMED`, `CHECKED_IN` consume seats; `CANCELLED` and
  `NO_SHOW` do not.
- Exceeding capacity on a `reservations` insert or update raises
  `SQLSTATE 'KEKI1'`.

> `CONFIRMED → CHECKED_IN` moves between two seat-consuming statuses, so it
> cannot trip the trigger. `CONFIRMED → NO_SHOW` moves *out* of the set, which
> releases a seat — the only capacity-affecting transition here.

WS-02's audit writer, whose `executor` is required precisely so the entry
cannot be written outside the caller's transaction:

```ts
export async function recordAuditEntry(input: {
  executor: Tx;
  actorCustomerId: CustomerId;
  action: AuditAction;
  entityType: AuditEntityType;
  entityId: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}): Promise<void>;
```

WS-01's transition table and schemas:

```ts
export const RESERVATION_TRANSITIONS: Readonly<
  Record<ReservationStatus, readonly ReservationStatus[]>
> = {
  HELD: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['CHECKED_IN', 'CANCELLED', 'NO_SHOW'],
  CHECKED_IN: ['CONFIRMED'],
  CANCELLED: [],
  NO_SHOW: [],
} as const;

export const checkInParticipantSchema = z.object({
  reservationParticipantId: z.string().uuid(),
}).strict();
```

The transaction helper, whose doc comment states the rule these commands rely
on:

```ts
/**
 * Opens a real Postgres transaction (BEGIN/COMMIT/ROLLBACK) ... Callers that
 * already hold a `Tx` should use it directly rather than nesting a new one.
 */
export function withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
```

## Implementation Steps

1. **Scaffold the package** by copying `catalog-admin`'s manifest shape.
   Dependencies are `@keki/contracts` and `@keki/database` **only** — not
   `@keki/reservation-core`, and not `@keki/catalog-admin`. All four scripts
   (`typecheck`, `lint`, `test`, `build`) must exist, per `AGENTS.md`.

   **Register it in `vitest.workspace.ts` in this workstream.** A package
   absent from the workspace never runs under `pnpm test`, so its coverage is
   invisible and every gate passes vacuously.

2. **Add typed errors** in `errors.ts`: `ReservationParticipantNotFoundError`,
   `ReservationNotFoundError`, `ReservationNotCheckInEligibleError` (carrying
   the current status), and `InvalidReservationTransitionError` (carrying both
   states).

   `ReservationNotCheckInEligibleError` carries the status because the UI must
   say *why* — "this booking is still an unfinished checkout" is actionable,
   "cannot check in" is not.

3. **Implement `checkInParticipant`** in `check-in.ts`:

   ```ts
   export async function checkInParticipant(input: {
     reservationParticipantId: ReservationParticipantId;
     actorCustomerId: CustomerId;
     now?: Date;
     tx?: Tx;
   }): Promise<{
     participantId: ReservationParticipantId;
     reservationId: ReservationId;
     checkedInAt: Date;
     reservationStatus: ReservationStatus;
     changed: boolean;
   }>;
   ```

   In one transaction, in this order:

   a. Load the participant joined to its reservation. Throw
      `ReservationParticipantNotFoundError` if absent.

   b. **If `checked_in_at` is already set, return early** with `changed: false`
      and the **original** timestamp. Do not restamp, and **write no audit
      row**. A double-tap on a busy morning is the expected case, not an error,
      and restamping would silently move an attendance record.

   c. Refuse unless the reservation status is `CONFIRMED` or `CHECKED_IN`.
      A `HELD` reservation is an unfinished checkout — throw
      `ReservationNotCheckInEligibleError` with the status. `CANCELLED` and
      `NO_SHOW` are refused the same way.

   d. Set `checked_in_at` to `now ?? new Date()`. **Never accept the timestamp
      from the caller's payload** — WS-01 already makes it unrepresentable in
      the schema; `now` exists for tests only.

   e. **Roll the reservation status up.** If it is `CONFIRMED`, check
      `canTransitionReservation('CONFIRMED', 'CHECKED_IN')` and update. If it
      is already `CHECKED_IN` (a second participant on the same booking), leave
      it — that is not a second transition.

   f. Write one audit row: `reservation.checked_in`, entity type
      `'reservation'`, `entityId` the **reservation** id, with the participant
      id in the `after` payload.

   Accept an optional `tx` so a caller composing several check-ins can share
   one transaction.

4. **Implement `undoCheckInParticipant`** with the same shape, returning
   `{ reservationId, reservationStatus, changed }`:

   a. If `checked_in_at` is already null, return `changed: false` and write no
      audit row — idempotent in both directions.

   b. Clear `checked_in_at`.

   c. **Count remaining checked-in participants on the reservation, inside the
      same transaction, after the clear.** Only if the count is zero, transition
      `CHECKED_IN → CONFIRMED`. With three children checked in, undoing one must
      leave the reservation `CHECKED_IN`.

      Counting before the clear, or counting outside the transaction, is the
      bug this step exists to prevent — both produce a status that disagrees
      with the rows beneath it.

   d. Write `reservation.check_in_undone`.

5. **Implement `markReservationNoShow`**:

   ```ts
   export async function markReservationNoShow(input: {
     reservationId: ReservationId;
     actorCustomerId: CustomerId;
     tx?: Tx;
   }): Promise<{ reservationId: ReservationId; changed: boolean }>;
   ```

   Guard on `canTransitionReservation(current, 'NO_SHOW')` — only `CONFIRMED`
   qualifies. A `CHECKED_IN` reservation cannot be a no-show: someone arrived.
   Throw `InvalidReservationTransitionError` naming both states.

   Perform the write as a single conditional UPDATE guarded on the current
   status, returning `changed: false` when it is already `NO_SHOW` rather than
   throwing. Write `reservation.no_show`.

   > This is the one transition that releases a seat, since `NO_SHOW` is not
   > seat-consuming. That is deliberate and recorded in the program's risk
   > register; do not add a compensating hold.

6. **Add the boundary test** mirroring `catalog-admin`'s: assert
   `package.json` declares only `@keki/contracts` and `@keki/database` among
   internal packages, and that no file under `apps/web/app/(customer)/` imports
   `@keki/staff-ops`.

7. **Do not modify `reservation-core`.** Its `confirmReservation` and
   `cancelReservation` stay as they are; retrofitting the transition table onto
   the checkout path is out of scope and would destabilize a working flow.

8. **Run all four scripts**, then `pnpm -r typecheck` and `pnpm test`
   workspace-wide.

## Tests

All database tests are `describe.skipIf(!hasLiveDatabase)` under a suite named
`integration: staff-ops check-in`, isolated by per-test `crypto.randomUUID()`
identifiers rather than truncation, so this suite cannot disturb others sharing
the CI branch.

1. **`checkInParticipant` sets `checked_in_at`** _(integration)_ — Assert the
   column is non-null afterward and within a second of `now`. **This is SC-03.**
2. **The first check-in moves the reservation to `CHECKED_IN`** _(integration)_ —
   Seed a `CONFIRMED` reservation; assert the status afterward is exactly
   `'CHECKED_IN'`. **This is SC-04.**
3. **A second participant does not re-transition** _(integration)_ — Two
   participants; check in both; assert exactly **one** `reservation.checked_in`
   audit row names a status change and the reservation is `CHECKED_IN` once.
4. **Check-in is idempotent** _(integration)_ — Check in twice; assert
   `changed` is `false` the second time, the `checked_in_at` value is
   **unchanged from the first call**, and exactly one audit row exists. **This
   is SC-06**, and asserting the timestamp is unchanged is what distinguishes
   idempotence from a silent restamp.
5. **Check-in on a `HELD` reservation is refused** _(integration)_ — Assert
   `ReservationNotCheckInEligibleError` carrying status `'HELD'`, and that
   `checked_in_at` is still null. **This is SC-07.**
6. **Check-in on a `CANCELLED` reservation is refused** _(integration)_ —
   Assert the same error shape.
7. **An unknown participant id throws** _(integration)_ — Assert
   `ReservationParticipantNotFoundError` and no write.
8. **Check-in does not change the occurrence's seat count** _(integration)_ —
   Record `bookedSeats` before and after; assert they are equal, since
   `CONFIRMED` and `CHECKED_IN` both consume. **This is SC-16.**
9. **Undo clears the timestamp** _(integration)_ — Assert `checked_in_at` is
   null afterward.
10. **Undoing the only check-in reverts to `CONFIRMED`** _(integration)_ —
    Assert the status is exactly `'CONFIRMED'`. **This is SC-05.**
11. **Undoing one of three leaves the reservation `CHECKED_IN`**
    _(integration)_ — Check in three participants, undo one; assert the status
    is still `'CHECKED_IN'` and the other two timestamps are untouched. This is
    the roll-up bug the workstream exists to avoid.
12. **Undo is idempotent** _(integration)_ — Undo twice; assert `changed` is
    `false` the second time and no second audit row.
13. **`markReservationNoShow` sets the status** _(integration)_ — Assert
    `'NO_SHOW'`.
14. **No-show releases the seat** _(integration)_ — Seed a 2-seat reservation
    against a capacity-2 occurrence, mark no-show, then assert
    `listBookableOfferings` reports 2 seats remaining rather than 0. **This is
    SC-08**, and asserting on the customer-visible count is what proves the
    release is real rather than only a status change.
15. **No-show on a `CHECKED_IN` reservation is refused** _(integration)_ —
    Assert `InvalidReservationTransitionError` naming both states. Someone
    arrived; they are not a no-show. **This is SC-09.**
16. **No-show is idempotent** _(integration)_ — Assert `changed: false` on the
    second call rather than an exception.
17. **Every mutation writes exactly one audit row** _(integration)_ — For each
    of the three commands, assert one row with the right action, `entityType:
    'reservation'`, and `entityId` equal to the **reservation** id. **This is
    SC-10.**
18. **The audit row names the actor** _(integration)_ — Assert
    `actorCustomerId` equals the caller's id, not a default or null.
19. **The check-in audit row carries the participant id** _(integration)_ —
    Assert the `after` payload contains it, since `entityId` is the reservation.
20. **A rolled-back check-in leaves no audit row** _(integration)_ — Force the
    participant update to fail inside the transaction; assert **zero** audit
    rows and that `checked_in_at` is still null. **This is SC-11**, and the
    test that proves the entry is inside the transaction rather than beside it.
21. **A rolled-back no-show leaves no audit row and no status change**
    _(integration)_ — Same shape for `markReservationNoShow`.
22. **A refused check-in writes no audit row** _(integration)_ — Attempt on a
    `HELD` reservation; assert it throws and the audit table is unchanged. A
    refusal is not an event.
23. **`staff-ops` is registered in the Vitest workspace** — Assert
    `vitest.workspace.ts` includes the package, so its suites actually run.
24. **`staff-ops` depends only on contracts and database** — Assert its
    `package.json` declares neither `@keki/reservation-core` nor
    `@keki/catalog-admin`.
25. **The customer surface does not import `staff-ops`** — Assert no file under
    `apps/web/app/(customer)/` imports it.

## Acceptance Criteria

1. `packages/staff-ops` passes all four scripts, and `pnpm -r typecheck` and
   `pnpm test` pass workspace-wide.
2. `checkInParticipant` sets `reservation_participants.checked_in_at` and rolls
   the reservation up to `CHECKED_IN` on the first participant (tests 1–3).
   **SC-03, SC-04.**
3. Check-in is idempotent, preserving the original timestamp and writing no
   second audit row (test 4). **SC-06.**
4. Check-in is refused on `HELD`, `CANCELLED`, and `NO_SHOW` reservations, with
   the current status carried on the error (tests 5–6). **SC-07.**
5. Check-in leaves the occurrence's seat count unchanged (test 8). **SC-16.**
6. Undo clears the timestamp and reverts the reservation **only** when no
   participant remains checked in, verified against a three-participant booking
   (tests 9–11). **SC-05.**
7. `markReservationNoShow` sets the status and the released seat is visible on
   the customer-facing query (tests 13–14). **SC-08.**
8. No-show is refused on a `CHECKED_IN` reservation via the transition table
   (test 15). **SC-09.**
9. All three commands write exactly one audit row naming actor, action, and the
   reservation as entity (tests 17–19). **SC-10.**
10. No audit entry survives a rolled-back mutation, and a refused operation
    writes none (tests 20–22). **SC-11.**
11. `staff-ops` is registered in the Vitest workspace and depends only on
    `contracts` and `database` (tests 23–25).
12. `reservation-core` is not modified.
