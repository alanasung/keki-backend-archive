# WS-06: reservation-core — capacity enforcement, holds, and expiry

## Goal

Implement the three reservation commands Phase 1 left as stubs on top of the
WS-02 database constraint, expose them through the `SeatHolder` port so
`commerce-core` can compose atomically without importing this package, and add
the expiry sweep that returns abandoned holds to the pool.

The guiding rule: **this package does not implement capacity — it translates the
database's refusal into a typed domain error.** Any counting done in TypeScript
to decide whether a booking may proceed is a bug, however well-intentioned.

This workstream is on the critical path and is the one most likely to overrun,
because correctness here is a concurrency property rather than a feature.

## Traceability

- **SC-08** — Two concurrent holds on a one-seat occurrence yield exactly one
  held seat, and after payment exactly one confirmed reservation.
- **SC-09** — An expired hold releases its seat and returns it to the available
  count.
- **SC-07** — Partially: supplies `confirmReservation`, which WS-10 calls when
  payment lands.
- **SC-19** — Partially: supplies the transaction-accepting `SeatHolder`
  implementation that makes WS-05's atomicity possible.

## Dependencies

- **WS-02** — Database (the capacity trigger and `seat_count`).

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Data access"; all access goes through `packages/database`
- `docs/vision.md` — "Core Concepts"; Reservation, Occurrence, Child
- `docs/as-built.md` — "Known Limitations"; the stub commands and absent capacity
  enforcement this workstream closes
- `packages/reservation-core/src/commands.ts` — the three stubs and the `TODO`
  stating `holdReservation` is where the check belongs
- `packages/reservation-core/src/queries.ts` — `countConfirmedParticipants` and
  its warning that it must not be repurposed as the check
- `packages/database/src/schema/reservations.ts` — `seat_count`, statuses, and
  the participant `CHECK`
- `packages/database/drizzle/0002_capacity_constraint.sql` — the trigger and its
  `SQLSTATE 'KEKI1'`
- `packages/contracts/src/ports.ts` — `SeatHolder`, `HeldSeat`,
  `TransactionScope`
- `packages/notification-core/src/outbox.ts` — `reclaimStaleClaims`, the reaper
  precedent this expiry sweep follows
- `functions/scheduled-task-worker/src/handler.ts` — the task-key switch

## Package

`packages/reservation-core`, plus a change to `functions/scheduled-task-worker`.

## Files Touched

- `packages/reservation-core/src/commands.ts` (MODIFY) — implement all three
- `packages/reservation-core/src/seat-holder.ts` (NEW) — the `SeatHolder`
  implementation
- `packages/reservation-core/src/expiry.ts` (NEW) — `expireStaleHolds`
- `packages/reservation-core/src/errors.ts` (MODIFY) — capacity error
- `packages/reservation-core/src/queries.ts` (MODIFY) — seat availability read
- `packages/reservation-core/src/index.ts` (MODIFY) — barrel
- `packages/reservation-core/src/commands.test.ts` (MODIFY)
- `packages/reservation-core/src/concurrency.test.ts` (NEW)
- `packages/reservation-core/src/expiry.test.ts` (NEW)
- `packages/reservation-core/src/seat-holder.test.ts` (NEW)
- `packages/contracts/src/messages.ts` (MODIFY) — add
  `reservation.expire-holds`
- `functions/scheduled-task-worker/src/handler.ts` (MODIFY) — handle it
- `functions/scheduled-task-worker/src/handler.test.ts` (MODIFY)

## Existing Interfaces to Consume

The stubs to implement, and the `TODO` naming this workstream's job:

```ts
// TODO(phase-2): Booking capacity rules land here. `holdReservation` is where
// the capacity check must live — it does not exist yet.
// `countConfirmedParticipants` in queries.ts reports occupancy; it does not
// enforce it, and must not be repurposed as the check.

export function holdReservation(input: {
  occurrenceId: OccurrenceId;
  householdId: HouseholdId;
  participants: readonly ReservationParticipant[];
}): Promise<Reservation> {
  return Promise.reject(new NotImplementedInPhase1('holdReservation'));
}

export function confirmReservation(input: { reservationId: ReservationId }): Promise<Reservation>;
export function cancelReservation(input: { reservationId: ReservationId; reason: string }): Promise<Reservation>;
```

The port this package must satisfy. Note `tx` is required — that is what lets
WS-05 make order creation and seat holding atomic:

```ts
export interface SeatHolder {
  holdSeats(input: {
    readonly occurrenceId: OccurrenceId;
    readonly householdId: HouseholdId;
    readonly createdByCustomerId: CustomerId;
    readonly participants: readonly CartParticipantRef[];
    readonly holdTtlMinutes: number;
    readonly tx: TransactionScope;
  }): Promise<HeldSeat>;
}

export interface HeldSeat {
  readonly occurrenceId: OccurrenceId;
  readonly reservationId: ReservationId;
  readonly seatCount: number;
}
```

The reaper precedent from `notification-core` — an abandoned lease returned to
the pool:

```ts
/** Returns rows stuck in CLAIMED past the lease window to PENDING. */
export declare function reclaimStaleClaims(input: {
  olderThanMs: number;
  maxAttempts?: number;
  now?: Date;
}): Promise<number>;
```

The row mapper already in this package, to reuse rather than duplicate:

```ts
function toReservation(row: ReservationRow): Reservation {
  return {
    id: createReservationId(row.id),
    occurrenceId: createOccurrenceId(row.occurrenceId),
    customerId: createCustomerId(row.createdByCustomerId),
    status: row.status,
    holdExpiresAt: row.holdExpiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
```

The database contract this package translates — from WS-02's trigger:

- `HELD`, `CONFIRMED`, `CHECKED_IN` consume seats.
- `CANCELLED` and `NO_SHOW` do not.
- Exceeding capacity raises `SQLSTATE 'KEKI1'`, message `capacity_exceeded`.

## Implementation Steps

1. **Add typed errors** in `errors.ts`: `CapacityExceededError` (carrying
   `occurrenceId` and `requestedSeats`), `ReservationNotFoundError`, and
   `InvalidReservationTransitionError`.

   `CapacityExceededError` must carry the occurrence id. WS-05 propagates it
   unwrapped and the UI needs to name which class sold out.

2. **Implement `holdReservation`** in `commands.ts`:

   ```ts
   export async function holdReservation(input: {
     occurrenceId: OccurrenceId;
     householdId: HouseholdId;
     createdByCustomerId: CustomerId;
     participants: readonly CartParticipantRef[];
     holdTtlMinutes?: number; // default 15
     tx?: TransactionScope;
     now?: Date;
   }): Promise<Reservation>;
   ```

   When `tx` is supplied, run inside it; otherwise open one. Every statement must
   use the same handle — this is what WS-05 composes with.

   Insert the `reservations` row as `HELD` with
   `seatCount = participants.length` and `holdExpiresAt = now + ttl`, then insert
   the `reservation_participants` rows, mapping each `CartParticipantRef` onto
   the customer-XOR-child columns the table's `CHECK` enforces.

   **Do not count seats before inserting.** Attempt the insert and let the WS-02
   trigger decide. Catch `SQLSTATE 'KEKI1'` and rethrow as
   `CapacityExceededError`, matching on the SQLSTATE and never on message text.

   Comment that a pre-check would be a time-of-check-to-time-of-use bug: any
   count read before the insert can be invalidated by a concurrent transaction
   before the insert lands. The trigger's row lock is the only thing that makes
   the decision safe, and only the inserting statement can hold it.

   Reject an empty participant list — a zero-seat hold consumes nothing and
   corrupts every downstream count.

3. **Implement the `SeatHolder` port** in `seat-holder.ts`:

   ```ts
   export function createSeatHolder(): SeatHolder;
   ```

   A thin adapter over `holdReservation` returning `HeldSeat`. Keep it thin:
   duplicating hold logic here would give two code paths that must both stay
   correct under concurrency.

4. **Implement `confirmReservation`**:

   ```ts
   export async function confirmReservation(input: {
     reservationId: ReservationId;
     now?: Date;
   }): Promise<{ reservation: Reservation; changed: boolean }>;
   ```

   Conditional `UPDATE ... WHERE id = $1 AND status IN ('HELD','CONFIRMED')`,
   setting `CONFIRMED` and clearing `holdExpiresAt`. Return `changed: false` when
   already `CONFIRMED` — WS-10 calls this from an SQS-retried webhook.

   **Confirming an already-cancelled or expired hold must fail** with
   `InvalidReservationTransitionError`. If the sweep already cancelled the row,
   the seat may have been resold; WS-10 treats this as needing staff follow-up
   rather than silently re-holding a seat that is gone.

   `CONFIRMED` also consumes a seat, so the trigger fires on this UPDATE — catch
   `KEKI1` here too.

5. **Implement `cancelReservation`**: conditional UPDATE to `CANCELLED` from any
   non-terminal status, recording the reason in `notes`, idempotent the same way.
   Cancelling frees the seat automatically because the trigger stops counting the
   row — no compensating bookkeeping.

6. **Implement `expireStaleHolds`** in `expiry.ts`:

   ```ts
   export async function expireStaleHolds(input: {
     now?: Date;
     limit?: number; // default 500
   }): Promise<number>;
   ```

   One statement: `UPDATE reservations SET status = 'CANCELLED' WHERE status =
   'HELD' AND hold_expires_at <= now()`, bounded by `limit`, returning the count.
   Select ids with `FOR UPDATE SKIP LOCKED`, following `claimDueNotifications`,
   so concurrent sweeps do not contend.

   Bound the batch — an unbounded UPDATE over a large backlog times the Lambda
   out mid-statement and rolls back the entire sweep.

   **This is what makes `HELD` safe.** A hold consumes a seat, so without expiry
   one abandoned checkout removes a seat from sale permanently.

7. **Add a seat-availability query** in `queries.ts`:
   `getSeatsRemaining(occurrenceId)`, using the same status set and
   `capacity_override` fallback as WS-02 and WS-04. Document it as display-only,
   mirroring the existing warning, and leave `countConfirmedParticipants`
   untouched.

8. **Add the `reservation.expire-holds` task key** to contracts and handle it in
   `scheduled-task-worker`. The exhaustive `never` default forces the case.

9. **Run all four scripts** and `pnpm -r typecheck`.

## Tests

All database tests are `describe.skipIf(!hasLiveDatabase)`. The concurrency
tests are the point of this workstream and must run against real Postgres — they
test a database lock, and a mocked version proves nothing.

1. **`holdReservation` creates a HELD row** — Assert status, `seatCount`, and
   `holdExpiresAt`.
2. **Participants are inserted** — One row per participant, with the correct
   customer-XOR-child column set.
3. **Hold and participants are atomic** — Force a participant insert failure;
   assert no reservation row remains.
4. **Empty participants is rejected** — Assert a validation error.
5. **`holdReservation` fills the last seat** — Capacity 1; assert success.
6. **Past capacity raises `CapacityExceededError`** — Assert the typed error, not
   a raw database error, and that it carries `occurrenceId`.
7. **Multi-seat holds respect `seat_count`** — Capacity 3, one 3-seat hold;
   assert a further 1-seat hold is rejected.
8. **No pre-count is used** — Spy on the db client; assert no SELECT-count is
   issued before the INSERT.
9. **Two concurrent holds on a one-seat occurrence: exactly one wins**
   _(integration)_ — Assert one resolves, one rejects with
   `CapacityExceededError`, and exactly one `HELD` row exists.
10. **After payment, exactly one confirmed reservation exists** _(integration)_ —
    Continue test 9: confirm the winner and attempt to confirm the loser; assert
    exactly one `CONFIRMED` row for the occurrence. **This completes SC-08 — a
    wrong implementation that never confirms the winner fails here while passing
    test 9.**
11. **Ten concurrent holds on a three-seat occurrence: exactly three win**
    _(integration)_ — Assert three successes, seven capacity errors, and total
    `seat_count` of exactly 3.
12. **`holdSeats` honours a supplied transaction** _(integration)_ — Open a
    transaction, call `holdSeats` with it, roll back; assert no reservation row
    survives. This is what WS-05's atomicity rests on.
13. **`holdSeats` returns the reservation id and seat count** — Assert the
    `HeldSeat` shape matches the inserted row.
14. **`confirmReservation` promotes a hold** — Assert `CONFIRMED` and
    `holdExpiresAt` cleared.
15. **`confirmReservation` is idempotent** — Second call returns
    `changed: false`.
16. **Confirming a cancelled hold fails** — Assert
    `InvalidReservationTransitionError`, not a silent success.
17. **`cancelReservation` frees the seat** — Fill capacity, cancel, assert a new
    hold succeeds.
18. **`cancelReservation` is idempotent.**
19. **`expireStaleHolds` cancels only expired holds** — Seed one expired and one
    future; assert only the expired one is cancelled.
20. **`expireStaleHolds` frees the seat** — Fill capacity with a hold, expire it,
    assert a new hold succeeds. **This is SC-09.**
21. **`expireStaleHolds` ignores confirmed reservations** — Assert a `CONFIRMED`
    row with a past `holdExpiresAt` is untouched, so paid bookings are never
    cancelled.
22. **`expireStaleHolds` respects the limit** — Seed 10 expired, sweep with
    `limit: 3`; assert 3.
23. **Concurrent sweeps do not double-process** _(integration)_ — Two sweeps over
    10 expired holds; assert counts sum to 10 with no overlap.
24. **`getSeatsRemaining` matches the trigger's status set** — Assert `HELD`
    counts and `CANCELLED` does not.
25. **`reservation.expire-holds` is a known task key** — Assert `isKnownTaskKey`
    accepts it and the worker dispatches it.
26. **`countConfirmedParticipants` is unchanged and unused** — Assert its
    existing tests pass and no command calls it.

## Acceptance Criteria

1. `packages/reservation-core` and `functions/scheduled-task-worker` pass all
   four scripts, and `pnpm -r typecheck` passes workspace-wide.
2. All three commands are implemented; none rejects with
   `NotImplementedInPhase1`.
3. **No command counts seats in TypeScript to decide whether a booking may
   proceed** (test 8). Capacity is decided by the WS-02 trigger alone.
4. `SQLSTATE 'KEKI1'` is translated into `CapacityExceededError`, matched by
   SQLSTATE rather than message text, carrying the occurrence id.
5. Concurrency tests 9, 10, 11, and 23 pass against real Postgres, including the
   assertion that exactly one reservation is **confirmed** (SC-08).
6. `createSeatHolder` implements the `contracts` port, honours a supplied
   transaction handle (test 12), and delegates to `holdReservation` rather than
   duplicating its logic.
7. `confirmReservation` and `cancelReservation` are idempotent and report
   `changed` accurately.
8. Confirming an already-cancelled or expired hold fails loudly.
9. `expireStaleHolds` is bounded, uses `SKIP LOCKED`, and returns seats to the
   pool (test 20).
10. `reservation.expire-holds` is a known task key handled by the worker.
11. `countConfirmedParticipants` is untouched and unused by the commands.
12. The `TODO(phase-2)` comment in `commands.ts` is removed.
