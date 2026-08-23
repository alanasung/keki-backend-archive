# keki-backend-prod — Program Plan (Phase 4 Staff Surfaces)

## Program Overview

**Product:** Keki is the commerce and operations platform for a cafe that runs
classes, rents rooms, and hosts open play. One Next.js 15 application on AWS
serves four surfaces — customer, kiosk, staff, admin — over a set of plain
TypeScript domain packages, with Square for payments, a waiver provider for
liability signing, and Klaviyo/SES/SMS for customer communication.

**Program scope:** Give front-of-house staff the surface they need on the day a
class runs. Phase 2 made classes sellable and Phase 3 made them creatable, but
nothing happens after a customer pays: no one can see today's schedule, mark
that a child arrived, or answer "how many people are in the building right
now."

This program closes the reservation lifecycle. `CHECKED_IN` has been a
reservation status since Phase 1 and **no code has ever written it** — it is a
state the machine cannot reach. `reservation_participants.checked_in_at` has
existed just as long and is never set.

## Strategic Goals

1. **Make the day of the class operable.** Staff see what is running, who is
   expected, and who has arrived — without a database query or a developer.
2. **Reach `CHECKED_IN`.** Close the hole in a state machine that already
   exists, at the granularity the schema was designed for: per participant.
3. **Answer "who is here right now."** Occupancy is the question staff and
   safety rules care about, and today it has no answer.
4. **Extend the audit trail beyond the catalog.** Phase 3 taught
   `staff_audit_log` to record catalog changes; check-in is exactly the kind of
   staff action it exists to record.
5. **Establish the `FRONT_OF_HOUSE` mutation boundary once**, the way Phase 3
   established `MANAGER`, so the kiosk surface copies it rather than inventing
   one.

## Architecture Changes

Changes from the system described in `docs/as-built.md` (current as of
`phase-3-admin-catalog`).

**One new package: `packages/staff-ops`.** Check-in is a reservation write
path, so `reservation-core` is the obvious home — but `reservation-core` is
imported by the customer checkout path, and putting staff mutations there makes
`checkIn` reachable from customer code. This mirrors the Phase 3 decision that
put write paths in `catalog-admin` rather than the customer-facing
`catalog-core`, and it inherits the same guard: a `package-boundaries.test.ts`
asserting `staff-ops` is never imported by `apps/web/app/(customer)/`.

The cost is honest and worth naming: reservation logic now lives in two
packages. `staff-ops` depends on `contracts` and `database` only, like every
other core, and does not import `reservation-core`.

**`recordAuditEntry` moves from `catalog-admin` to `packages/database`.**
Phase 3 put it inside `catalog-admin` because that was its only caller. It is a
single-table insert taking a transaction handle — data access, not catalog
domain logic — and `staff-ops` now needs it too. Staff code must not depend on
`catalog-admin` to write an audit row. `catalog-admin` re-exports it during the
move so no caller breaks.

**Check-in is per participant, not per reservation.** A household books three
seats and two children arrive; that is the normal case, and
`reservation_participants.checked_in_at` is where the schema already put the
answer. The reservation's `CHECKED_IN` status is a **roll-up** — set when the
first participant arrives, not a separate source of truth. Two representations
of the same fact would drift, so the participant timestamp is authoritative and
the status is derived from it.

**Reservation status becomes a real state machine.** `RESERVATION_STATUSES` has
been an enum since Phase 1 with nothing guarding the moves between its values.
This adds `RESERVATION_TRANSITIONS` in `contracts`, mirroring
`OFFERING_TRANSITIONS` and `ORDER_TRANSITIONS` — the third instance of a
pattern that is now clearly the house style.

**`CAFE_TIME_ZONE` moves to `contracts`.** Phase 3's WS-07 exported it from
`apps/web/app/(customer)/book/class-listing.tsx` so the admin schedule could
reuse it. "Today" is a timezone question that `staff-ops` must answer inside a
query, and a package cannot import from `apps/web`. It belongs in `contracts`
by the rule already written in `AGENTS.md`: a value crossing a package boundary
lives there, not duplicated at both ends.

**No check-out.** There is no `checked_out_at` column and this program does not
add one. Occupancy is derived from checked-in participants whose occurrence has
not yet ended. That is an approximation — someone who leaves early still counts
until their class ends — and it is stated plainly on the page rather than
implied to be a live door count.

## Technology Choices

No new technology — uses the existing stack. Five decisions this program
settles that the brief left open:

| Decision | Choice | Rationale |
| --- | --- | --- |
| Check-in granularity | Per participant; reservation status is a roll-up | `reservation_participants.checked_in_at` already exists. A household books three seats and two children arrive — per-reservation check-in cannot express that. |
| Undoing a check-in | Allowed; clears the timestamp and reverts the roll-up | A mis-tap on a busy morning is inevitable, and the alternative is a wrong record no one can correct. |
| Walk-ups | Out of scope | Creating a reservation from the staff surface means a booking and a payment flow. It is a program of its own, not a control on a check-in page. |
| Occupancy freshness | As of page load, with an explicit refresh | Polling or streaming buys seconds of accuracy for a number that changes a few times an hour. The page states its own as-of time. |
| Marking `NO_SHOW` | Allowed, and it releases the seat | `NO_SHOW` is not seat-consuming under the capacity trigger. The class has already started, so a released seat is harmless, and the alternative leaves staff no way to record what happened. |

## Workstreams

| ID | Workstream | Dependencies | Estimated Effort |
| --- | --- | --- | --- |
| WS-01 | Contracts: reservation transitions, check-in schemas, staff audit actions, `CAFE_TIME_ZONE` | — | S |
| WS-02 | Move `recordAuditEntry` from `catalog-admin` to `packages/database` | — | S |
| WS-03 | `staff-ops`: check-in, undo, and no-show commands | WS-01, WS-02 | M |
| WS-04 | `staff-ops`: today's schedule, roster, and occupancy queries | WS-01 | M |
| WS-05 | Staff Server Actions with the `FRONT_OF_HOUSE` boundary | WS-03, WS-04 | S |
| WS-06 | `/staff/today`: today's occurrences with expected and arrived counts | WS-05 | M |
| WS-07 | `/staff/check-in`: per-participant check-in for an occurrence | WS-05 | M |
| WS-08 | `/staff/occupancy`: who is in the building now | WS-04 | M |
| WS-09 | Tests, e2e coverage, and documentation | WS-06, WS-07, WS-08 | M |

**Size key:** S = 1–2 days, M = 3–5 days, L = 5–10 days

### Workstream detail

- **WS-01** — `RESERVATION_TRANSITIONS` plus `canTransitionReservation`,
  mirroring the offering and order machines. Zod schemas for check-in input.
  New `AUDIT_ACTIONS` members for check-in, undo, and no-show. Moves
  `CAFE_TIME_ZONE` in from `apps/web`, leaving a re-export so the customer and
  admin pages keep working.
- **WS-02** — A pure refactor: `recordAuditEntry` and `changedFields` move to
  `packages/database`, with `catalog-admin` re-exporting them. No behavior
  changes, and the Phase 3 audit tests must pass untouched — that is the proof
  the move was faithful.
- **WS-03** — `checkInParticipant`, `undoCheckInParticipant`, and
  `markReservationNoShow`. Each writes its audit row in the same transaction,
  the pattern Phase 3's WS-04 established. Refuses check-in on a `HELD`
  reservation: a hold is an unfinished checkout, not an attendee.
- **WS-04** — `listTodaysOccurrences` (cafe-timezone day boundaries, not a
  rolling 24 hours), `listOccurrenceRoster` (participants with names and
  check-in state), and `getCurrentOccupancy`. All aggregate queries, no N+1.
- **WS-05** — Staff actions through `authenticatedAction({ requiredRole:
  'FRONT_OF_HOUSE' })`, reusing the envelope and error mapping. The `/staff`
  layout guard stays as the route-level check.
- **WS-06** — Today's schedule: each occurrence with its time, class name, and
  expected-versus-arrived counts, linking to its check-in page.
- **WS-07** — The check-in surface: a roster per occurrence with a control per
  participant, an undo path, and a no-show control per reservation.
- **WS-08** — Occupancy: a headcount of checked-in participants in in-progress
  occurrences, broken down by class, with its as-of time stated.
- **WS-09** — A Playwright journey covering today → check in a participant →
  occupancy reflects them, plus integration coverage for the audit-in-transaction
  guarantee and documentation.

## Dependency Graph

```
     WS-01 (contracts)          WS-02 (audit extraction)
        |        \                    /
        |         \                  /
        |          \                /
        |        WS-03 (check-in commands)
        |               |
   WS-04 (queries)      |
      |     \           |
      |      \          |
      |     WS-05 (staff actions)
      |        /            \
      |       /              \
 WS-08 (occupancy)   WS-06 (today)   WS-07 (check-in UI)
      \                |                  /
       +---------------+-----------------+
                       |
                WS-09 (tests + docs)

WS-03 depends on WS-01 and WS-02 — it needs the transition table and the
  relocated audit writer.
WS-04 depends on WS-01 only — queries need CAFE_TIME_ZONE, not the audit writer.
WS-08 depends on WS-04 only — occupancy is read-only and needs no Server Action.
```

Parallelism: WS-01 and WS-02 are independent and can run at once. WS-04 runs
alongside WS-03. WS-08 fans out from WS-04 without waiting for WS-05, so it
carries real slack; WS-06 and WS-07 do not.

## Critical Path

```
WS-01 → WS-03 → WS-05 → WS-07 → WS-09
```

Roughly 17 working days serialized. The path runs through check-in rather than
through the schedule view, because check-in is the only workstream that writes
anything — `/staff/today` and `/staff/occupancy` are both views over data that
check-in produces.

The one place to be careful is WS-03. Check-in looks like setting a timestamp
and is not: it maintains a roll-up status that must stay consistent with the
participant rows underneath it, it must be idempotent under a double-tap, and
undo has to decide correctly whether any participant remains checked in before
reverting the reservation.

WS-02 is small but sits under the critical path's second link. If the audit
extraction slips, WS-03 cannot start.

## Scope (In)

- `packages/staff-ops` with check-in write paths and staff read paths
- Per-participant check-in, writing `reservation_participants.checked_in_at`
- Reservation status roll-up to `CHECKED_IN`, guarded by a transition table
- Undoing a check-in, including reverting the roll-up
- Marking a reservation `NO_SHOW`
- `staff_audit_log` writes inside each mutation's transaction
- Staff Server Actions gated on `FRONT_OF_HOUSE`
- `/staff/today`, `/staff/check-in`, `/staff/occupancy`
- `recordAuditEntry` relocated to `packages/database`
- `CAFE_TIME_ZONE` relocated to `packages/contracts`
- Unit, integration, and Playwright coverage; documentation

## Scope (Out)

Explicitly deferred — do not implement in this program:

- Walk-up bookings, or creating any reservation from the staff surface
- Check-out, and any `checked_out_at` column
- Real-time or polled occupancy
- Editing or moving a reservation, and changing seat counts
- Refunds, and any dependency on `refundPayment`
- Waiver capture at check-in — `waiver_record_id` stays untouched
- Play passes and redemption at check-in
- `/kiosk/book` and `/kiosk/waiver`, which stay placeholders
- `/admin/customers`, which stays a placeholder
- An audit-log viewer — this program writes entries, it does not display them
- Notification sends on check-in
- Historical attendance reporting

## Risk Register

| Risk | Impact | Mitigation |
| --- | --- | --- |
| The roll-up status drifts from the participant timestamps | High — `/staff/today` and `/staff/occupancy` disagree about who arrived, and the audit trail records a state that never existed | The participant timestamp is the single source of truth; the status is always derived inside the same transaction, never set independently. A WS-03 test checks in and undoes across a multi-participant reservation and asserts the status matches the participants at every step. |
| Extracting `recordAuditEntry` breaks Phase 3's audit guarantee | **Critical** — SC-11 of the previous program was the hardest thing it proved, and a refactor could silently move the write outside the transaction | `catalog-admin` re-exports the relocated function, and the entire Phase 3 audit suite must pass **unmodified**. A WS-02 acceptance criterion forbids editing those tests. |
| Check-in on a `HELD` reservation | Medium — an unfinished checkout is recorded as an attendee, and the seat is never paid for | Refused at the command with a typed error. A WS-03 test asserts a `HELD` reservation cannot be checked in. |
| Double-tap on a busy morning creates a second event | Medium — duplicate audit rows, and a check-in time that moves | Check-in is idempotent: an already-checked-in participant keeps its original `checked_in_at` and writes no second audit row. |
| "Today" computed in the server's timezone | Medium — staff see tomorrow's classes after 5pm Pacific, or lose the evening's | Day boundaries come from `CAFE_TIME_ZONE`, moved into `contracts` for exactly this reason. A WS-04 test pins an instant that falls on a different UTC day. |
| Occupancy overstates who is present | Medium — there is no check-out, so an early departure still counts | Accepted and stated on the page. Occupancy is scoped to in-progress occurrences so it self-clears when a class ends, rather than growing all day. |
| `NO_SHOW` releases a seat that is then resold | Low — the class has already started, so a resale is harmless and arguably correct | Accepted deliberately; recorded in this table so a later reader knows it was considered rather than missed. |
| Staff actions reachable without `FRONT_OF_HOUSE` | **Critical** — any signed-in customer could mark attendance | Two independent checks: the existing `/staff` layout guard, and `requiredRole` on every action. A WS-05 test calls each action as a `CUSTOMER`. |
| Reservation logic split across two packages | Medium — a future reader looks for check-in in `reservation-core` and does not find it | Named in Architecture Changes above, and `staff-ops` carries a doc comment pointing at `reservation-core` for the customer-side lifecycle. |

## Success Criteria

| ID | Outcome |
| --- | --- |
| SC-01 | `/staff/today` lists today's occurrences with start time, class name, and expected-versus-arrived counts. |
| SC-02 | "Today" is computed in the cafe's timezone, not the server's, and not as a rolling 24 hours. |
| SC-03 | Staff can check in an individual participant, setting `reservation_participants.checked_in_at`. |
| SC-04 | Checking in the first participant of a reservation moves it `CONFIRMED → CHECKED_IN`. |
| SC-05 | Undoing a check-in clears the timestamp, and the reservation returns to `CONFIRMED` only when no participant remains checked in. |
| SC-06 | Check-in is idempotent: repeating it preserves the original `checked_in_at` and writes no second audit row. |
| SC-07 | Checking in a `HELD` reservation is refused with a message naming why. |
| SC-08 | Staff can mark a reservation `NO_SHOW`, and its seats are released. |
| SC-09 | An undeclared reservation transition is refused by `RESERVATION_TRANSITIONS`. |
| SC-10 | Every staff mutation writes a `staff_audit_log` row naming the actor, action, and entity. |
| SC-11 | An audit entry never survives a staff mutation that rolled back. |
| SC-12 | Phase 3's audit suite passes unmodified after `recordAuditEntry` moves to `packages/database`. |
| SC-13 | Every staff action rejects a caller whose role is below `FRONT_OF_HOUSE`. |
| SC-14 | `/staff/check-in` lists an occurrence's participants by name with their check-in state and a control for each. |
| SC-15 | `/staff/occupancy` reports checked-in participants of in-progress occurrences, excludes occurrences that have ended, and states its as-of time. |
| SC-16 | Checking a participant in does not change the occurrence's seat count, since `CONFIRMED` and `CHECKED_IN` both consume a seat. |
| SC-17 | Playwright covers a staff journey: view today, check a participant in, and see occupancy reflect them. |
