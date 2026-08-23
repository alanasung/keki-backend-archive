# WS-01: Contracts — reservation transitions, check-in schemas, staff audit actions, `CAFE_TIME_ZONE`

## Goal

Add the vocabulary the staff surface needs: a transition table that makes the
reservation lifecycle enforceable rather than decorative, input schemas for
check-in, the audit actions a staff mutation records against, and a home in
`contracts` for the cafe timezone that a domain package can actually import.

`RESERVATION_STATUSES` has been an enum since Phase 1 with nothing guarding the
moves between its values — the third such enum, after offerings and orders.
`CAFE_TIME_ZONE` currently lives in a customer page component, which a package
cannot import.

Types, schemas, and constants only. No runtime behavior beyond schema
definitions and one pure predicate.

## Traceability

- **SC-09** — Partially: defines the transition table that makes an undeclared
  reservation transition refusable. WS-03 enforces it.
- **SC-02** — Partially: relocates `CAFE_TIME_ZONE` so WS-04 can compute the
  cafe's day boundaries inside a query.
- **SC-10** — Partially: defines the staff audit actions every mutation records
  against.

## Dependencies

None. This is a root of the program, alongside WS-02.

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Module boundaries"; a value crossing a package boundary
  belongs in `contracts`, not duplicated at both ends
- `docs/vision.md` — "Core Concepts" and "Target Users"; the Front of house
  persona
- `packages/contracts/src/admin.ts` — `OFFERING_TRANSITIONS`,
  `canTransitionOffering`, `AUDIT_ACTIONS`, `AUDIT_ENTITY_TYPES`, the patterns
  this workstream extends
- `packages/contracts/src/entities.ts` — `RESERVATION_STATUSES`,
  `Reservation`, `ReservationParticipant`, `SEAT_CONSUMING_STATUSES`
- `packages/contracts/src/orders.ts` — `ORDER_TRANSITIONS` and `canTransition`
- `packages/database/src/schema/reservations.ts` — the `reservations` and
  `reservation_participants` columns these schemas describe
- `apps/web/app/(customer)/book/class-listing.tsx` — where `CAFE_TIME_ZONE` is
  declared today and why it is pinned
- `apps/web/app/admin/schedules/page.tsx` — the second consumer of that
  constant, which must keep working
- `packages/contracts/src/index.ts` — the barrel

## Package

`packages/contracts`, plus two import updates in `apps/web`

## Files Touched

- `packages/contracts/src/staff.ts` (NEW) — reservation transitions, check-in schemas, staff audit vocabulary
- `packages/contracts/src/admin.ts` (MODIFY — extend `AUDIT_ACTIONS` and `AUDIT_ENTITY_TYPES`)
- `packages/contracts/src/entities.ts` (MODIFY — add `CAFE_TIME_ZONE`)
- `packages/contracts/src/index.ts` (MODIFY — export the new module)
- `packages/contracts/src/staff.test.ts` (NEW)
- `apps/web/app/(customer)/book/class-listing.tsx` (MODIFY — import `CAFE_TIME_ZONE` instead of declaring it)
- `apps/web/app/admin/schedules/page.tsx` (MODIFY — import from `@keki/contracts`)

## Existing Interfaces to Consume

The offering transition table this mirrors. Same shape, same reasoning — the
machine is data, not scattered conditionals:

```ts
export const OFFERING_TRANSITIONS: Readonly<Record<OfferingStatus, readonly OfferingStatus[]>> = {
  DRAFT: ['PUBLISHED', 'ARCHIVED'],
  PUBLISHED: ['DRAFT', 'ARCHIVED'],
  ARCHIVED: [],
} as const;

export function canTransitionOffering(from: OfferingStatus, to: OfferingStatus): boolean {
  return OFFERING_TRANSITIONS[from].includes(to);
}
```

The reservation statuses, and the seat-consuming subset that constrains which
transitions are capacity-safe:

```ts
export const RESERVATION_STATUSES = [
  'HELD',
  'CONFIRMED',
  'CHECKED_IN',
  'CANCELLED',
  'NO_SHOW',
] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export const SEAT_CONSUMING_STATUSES = ['HELD', 'CONFIRMED', 'CHECKED_IN'] as const;
```

The audit vocabulary being extended. Note `AUDIT_ENTITY_TYPES` has only two
members today:

```ts
export const AUDIT_ACTIONS = [
  'offering.created', 'offering.updated', 'offering.published',
  'offering.unpublished', 'offering.archived',
  'occurrence.scheduled', 'occurrence.updated', 'occurrence.cancelled',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_ENTITY_TYPES = ['offering', 'occurrence'] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];
```

The constant being relocated, with the comment explaining why it is pinned:

```ts
// Occurrence times render in the cafe's timezone ... Rendering in the
// server's zone or in UTC would show customers the wrong time twice a
// year, so every formatter below is pinned to this single named constant.
// Exported so /admin/schedules (WS-07) renders the same class at the same
// local hour instead of declaring a second constant that could drift.
export const CAFE_TIME_ZONE = 'America/Los_Angeles';
```

The participant union check-in operates on — exactly one of `customerId` or
`childId` is set:

```ts
export type ReservationParticipant = ReservationParticipantBase &
  ({ customerId: CustomerId; childId?: never } | { childId: ChildId; customerId?: never });
```

## Implementation Steps

1. **Move `CAFE_TIME_ZONE` into `entities.ts`**, carrying its doc comment
   across and extending it to say that domain packages compute the cafe's day
   boundaries from it.

   Then update both consumers to import it from `@keki/contracts`. **Do not
   leave a re-export in `class-listing.tsx`.** A re-export would let a future
   reader import it from either place and reintroduce exactly the drift this
   move exists to prevent — and there are only two call sites, both updated
   here.

2. **Add the reservation transition table** in `staff.ts`:

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

   export function canTransitionReservation(
     from: ReservationStatus,
     to: ReservationStatus,
   ): boolean;
   ```

   Four edges deserve their reasoning recorded in the file:

   - **`CHECKED_IN → CONFIRMED`** is how undo works. Both statuses consume a
     seat, so the reversal cannot fail on capacity.
   - **`NO_SHOW` is terminal**, deliberately. `NO_SHOW` is *not*
     seat-consuming, so reversing it must re-acquire a seat that may already
     have been taken — the capacity trigger would raise `KEKI1` and the staff
     member would see a failure they cannot act on. Correcting a mistaken
     no-show is out of scope for this program; make it unrepresentable rather
     than half-supported.
   - **`CANCELLED` is terminal**, matching what `reservation-core` already
     does.
   - **`HELD → CHECKED_IN` is absent.** A hold is an unfinished checkout, not
     an attendee; check-in must go through `CONFIRMED`.

   > This table describes the whole reservation machine, but **this program
   > enforces it only at the staff boundary (WS-03)**. `reservation-core`'s
   > existing `confirmReservation` and `cancelReservation` are not modified —
   > retrofitting them is a separate change that would destabilize the
   > checkout path this program does not otherwise touch. The table's edges
   > must therefore *describe* what `reservation-core` already does, not
   > contradict it.

3. **Add the check-in input schemas** in the same file:

   ```ts
   export const checkInParticipantSchema = z.object({
     reservationParticipantId: z.string().uuid(),
   }).strict();

   export const undoCheckInParticipantSchema = checkInParticipantSchema;

   export const markNoShowSchema = z.object({
     reservationId: z.string().uuid(),
   }).strict();
   ```

   `checkedInAt` is **not** an input. The command stamps it from the server
   clock; accepting it would let a caller backdate an attendance record, which
   is precisely the kind of claim an audit trail exists to make trustworthy.

   Check-in is keyed by **participant**, not by reservation plus a person
   reference. The participant row is the thing being marked, it already has an
   id, and keying by it makes "check in one of the three children on this
   booking" expressible without a compound lookup.

4. **Extend the audit vocabulary** in `admin.ts`:

   ```ts
   // appended to AUDIT_ACTIONS
   'reservation.checked_in',
   'reservation.check_in_undone',
   'reservation.no_show',

   // appended to AUDIT_ENTITY_TYPES
   'reservation',
   ```

   Append rather than reorder — `AUDIT_ACTIONS` is a closed set whose values
   are already persisted in `staff_audit_log` rows, and reordering would not
   break anything today but invites someone to treat position as meaningful.

   Add `'reservation'` to `AUDIT_ENTITY_TYPES` even though check-in marks a
   participant row: the entity a reader cares about is the booking, and
   `entityId` carries the reservation id so an auditor can find it. Record the
   participant in the `after` payload instead.

5. **Export from the barrel** and run all four scripts for both packages, then
   `pnpm -r typecheck` workspace-wide — the `CAFE_TIME_ZONE` move touches
   `apps/web`, so a package-local typecheck is not sufficient evidence.

## Tests

1. **`canTransitionReservation` permits declared edges** — Assert
   `CONFIRMED → CHECKED_IN`, `CHECKED_IN → CONFIRMED`, `CONFIRMED → NO_SHOW`,
   and `HELD → CONFIRMED` are all allowed.
2. **`canTransitionReservation` refuses `HELD → CHECKED_IN`** — Assert `false`.
   A hold is an unfinished checkout, and this is the edge most likely to be
   added by accident.
3. **`NO_SHOW` is terminal** — Assert `RESERVATION_TRANSITIONS.NO_SHOW` is
   empty, and that `NO_SHOW → CONFIRMED` is refused. Reversal would have to
   re-acquire a released seat.
4. **`CANCELLED` is terminal** — Assert the array is empty.
5. **The table covers every status** — Assert
   `Object.keys(RESERVATION_TRANSITIONS)` equals `RESERVATION_STATUSES`, so
   adding a status without a rule fails the build rather than silently denying
   every move.
6. **Every declared target is itself a valid status** — Assert every value in
   every array is a member of `RESERVATION_STATUSES`, catching a typo that
   would otherwise be a silently-never-satisfied edge.
7. **Undo stays within the seat-consuming set** — Assert both `CHECKED_IN` and
   `CONFIRMED` are in `SEAT_CONSUMING_STATUSES`, which is what makes the undo
   edge incapable of failing on capacity. This test fails if someone later
   removes `CHECKED_IN` from that set without revisiting undo.
8. **`checkInParticipantSchema` rejects a supplied `checkedInAt`** — Parse an
   input carrying it; assert failure. This is what keeps the server clock
   authoritative and attendance records un-backdatable.
9. **`checkInParticipantSchema` rejects a non-uuid id** — Assert `'abc'` fails
   and a valid uuid passes.
10. **`markNoShowSchema` rejects unknown keys** — Parse `{ reservationId, status:
    'NO_SHOW' }`; assert failure, proving the caller cannot smuggle a target
    status past the command.
11. **The new audit actions exist and are distinct** — Assert
    `reservation.checked_in`, `reservation.check_in_undone`, and
    `reservation.no_show` are all present in `AUDIT_ACTIONS` and are three
    different values. "Who marked this child absent" is a different question
    from "who checked them in".
12. **The pre-existing audit actions are unchanged** — Assert all eight Phase 3
    values are still present, so appending did not disturb them.
13. **`'reservation'` is a valid audit entity type** — Assert it is in
    `AUDIT_ENTITY_TYPES` alongside `offering` and `occurrence`.
14. **`CAFE_TIME_ZONE` is exported from `@keki/contracts`** — Assert the value
    is `'America/Los_Angeles'`, so a rename cannot silently change which zone
    the whole system renders in.
15. **`CAFE_TIME_ZONE` is no longer declared in `class-listing.tsx`** — Read the
    file and assert it contains no `const CAFE_TIME_ZONE =` declaration, only
    an import. This is the assertion that proves the move happened rather than
    a second copy being added.
16. **`class-listing.tsx` renders the same local day after the move** — Format a
    UTC instant that falls on the previous local day; assert the local date
    still renders, proving the relocated constant is actually applied.

## Acceptance Criteria

1. `packages/contracts` and `apps/web` pass all four scripts, and
   `pnpm -r typecheck` passes workspace-wide.
2. `RESERVATION_TRANSITIONS` covers every `RESERVATION_STATUSES` member, permits
   `CONFIRMED → CHECKED_IN` and `CHECKED_IN → CONFIRMED`, and leaves both
   `NO_SHOW` and `CANCELLED` terminal (tests 1–6).
3. `HELD → CHECKED_IN` is refused (test 2).
4. The undo edge is provably capacity-safe: both of its statuses are
   seat-consuming (test 7).
5. `checkInParticipantSchema` makes `checkedInAt` **unrepresentable** as input,
   and every schema parses strictly (tests 8–10).
6. Check-in input is keyed by `reservationParticipantId`, not by a reservation
   plus a person reference.
7. Three distinct staff audit actions exist, the eight Phase 3 actions are
   untouched, and `'reservation'` is a valid entity type (tests 11–13).
8. `CAFE_TIME_ZONE` is exported from `@keki/contracts`, is **no longer
   declared** in `apps/web`, and both former consumers import it (tests 14–16).
9. `reservation-core` is not modified — the transition table describes the full
   machine but is enforced only at the staff boundary, by WS-03.
10. No runtime behavior beyond schema definitions and `canTransitionReservation`
    is added.
