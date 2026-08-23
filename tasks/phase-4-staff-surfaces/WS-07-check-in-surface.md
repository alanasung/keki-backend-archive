# WS-07: `/staff/check-in` — per-participant check-in for an occurrence

## Goal

Replace the `/staff/check-in` placeholder with the screen a staff member uses
while people are walking through the door.

This is the workstream that makes `CHECKED_IN` reachable from a browser. It is
also the only surface in this program with a mutation, and the conditions are
hostile: someone is holding a tablet, a queue is forming, and a mis-tap must be
correctable in one action.

## Traceability

- **SC-14** — `/staff/check-in` lists an occurrence's participants by name with
  their check-in state and a control for each.
- **SC-03** — Partially: the control that sets `checked_in_at`. WS-03 performs
  the write.
- **SC-05** — Partially: the undo control.
- **SC-07** — Partially: shows why a check-in was refused.
- **SC-08** — Partially: the no-show control.

## Dependencies

- **WS-05** — Staff Server Actions.

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Auth" and "Module boundaries"
- `docs/vision.md` — "Target Users"; Front of house checks people in
- `apps/web/app/staff/check-in/page.tsx` — the placeholder being replaced
- `apps/web/app/staff/actions/check-in-actions.ts` — WS-05's actions
- `apps/web/app/admin/reservations/occurrence-roster.tsx` — the roster pattern,
  including the `'Unknown participant'` and no-participants fallbacks it
  already handles
- `apps/web/app/admin/offerings/offering-row.tsx` — the client-island +
  `useTransition` pattern for a row-level mutation
- `packages/staff-ops/src/queries.ts` — WS-04's `listOccurrenceRoster` and
  `listTodaysOccurrences`
- `packages/ui/src/components/status-badge.tsx` — Phase 3's badge
- `apps/web/app/nav-config.test.ts` — the placeholder brief and allowlist

## Package

`apps/web` and `packages/ui`

## Files Touched

- `apps/web/app/staff/check-in/page.tsx` (MODIFY — replace the placeholder)
- `apps/web/app/staff/check-in/roster-row.tsx` (NEW — client island)
- `apps/web/app/staff/check-in/occurrence-picker.tsx` (NEW)
- `apps/web/app/staff/check-in/page.test.tsx` (NEW)
- `apps/web/app/staff/check-in/roster-row.test.tsx` (NEW)
- `apps/web/app/nav-config.test.ts` (MODIFY — check-in is no longer a placeholder)

## Existing Interfaces to Consume

The placeholder being replaced, in full:

```tsx
import { PageShell, PlaceholderPanel } from '@keki/ui';

export default function StaffCheckInPage() {
  return (
    <PageShell title="Check-in" description="Check guests in for today's sessions.">
      <PlaceholderPanel title="Check-in" plannedFor="Phase 2" />
    </PageShell>
  );
}
```

WS-04's roster, already ordered un-arrived first:

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

WS-05's actions. Note every success carries `changed`, so an idempotent repeat
is distinguishable from a real change:

```ts
export const checkInParticipantAction: (raw: unknown) => Promise<
  ActionResult<{ participantId: ReservationParticipantId; reservationId: ReservationId;
    checkedInAt: Date; reservationStatus: ReservationStatus; changed: boolean }>
>;
export const undoCheckInParticipantAction: (raw: unknown) => Promise<
  ActionResult<{ reservationId: ReservationId; reservationStatus: ReservationStatus; changed: boolean }>
>;
export const markNoShowAction: (raw: unknown) => Promise<
  ActionResult<{ reservationId: ReservationId; changed: boolean }>
>;
```

## Implementation Steps

1. **Build the page** in `page.tsx` as a Server Component. Take the occurrence
   from a `searchParams` value rather than component state, so a roster is
   linkable — WS-06's cards link straight here, and a staff member will want to
   send one to a colleague.

   Default to the **in-progress** occurrence when none is supplied, falling
   back to the next one starting today. Landing on a chooser when exactly one
   class is running is a worse first impression than landing on the roster
   almost certainly wanted.

2. **Build the occurrence picker** in `occurrence-picker.tsx` so a staff member
   can switch classes without going back to `/staff/today`. List today's
   occurrences with their times; mark the selected one.

   If today has no occurrences, say so and link to `/staff/today` rather than
   rendering an empty picker.

3. **Build the roster row** in `roster-row.tsx` as a `'use client'` island,
   one per participant:

   - **Un-arrived** → a **Check in** control
   - **Arrived** → the local check-in time, and an **Undo** control

   Make the check-in control large. This is used one-handed on a tablet with a
   queue forming, and a small tap target is a mis-tap.

   Show the participant's name prominently and whether they are a child — staff
   are matching a name to a face at a counter.

4. **Disable the control while pending** via `useTransition`, and keep the row
   in place rather than removing it on success. A row that vanishes under a
   finger is how the next person gets checked in by accident.

   On success with `changed: false`, show "already checked in" rather than an
   error. Two staff members tapping the same name is expected, not a failure.

5. **Surface refusals in the row that caused them.** A `CONFLICT` from
   `checkInParticipantAction` carries the reservation's current status; render
   that message rather than a generic failure. "This booking is still an
   unfinished checkout" is actionable; "something went wrong" is not. **SC-07.**

6. **Add the no-show control per reservation, not per participant.** `NO_SHOW`
   is a reservation-level status, and offering it per participant would imply a
   granularity the command does not have.

   Group rows by reservation so the control has an obvious home, and confirm
   before marking — **state that it releases the seats**, since that is the
   consequence a staff member cannot see. Show no no-show control on a
   reservation that already has anyone checked in; the server refuses it and
   offering an impossible action is worse than not offering it.

7. **Handle the empty roster** — an occurrence with no bookings is ordinary.
   Say "nobody is booked for this class" rather than rendering an empty list.

   Render `'Unknown participant'` for a name that does not resolve, exactly as
   WS-04 returns it, rather than a blank row. Phase 3 shipped a roster that
   rendered eleven blank rows because `[].join()` is the empty string; do not
   repeat it.

8. **Update `nav-config.test.ts`**: remove `/staff/check-in` from the
   placeholder brief and add `staff${sep}check-in${sep}` to the data-access
   allowlist.

9. **Run all four scripts** for both packages.

## Tests

Component tests with Vitest; `@keki/staff-ops` and the actions mocked at the
module boundary.

1. **The roster lists participants by name** — Mock three; assert all three
   names render, not ids. **This is SC-14.**
2. **A child participant is distinguished from an adult** — Assert the two
   render differently, since staff are matching names to faces.
3. **An un-arrived participant shows a check-in control** — Assert the control
   is present and no undo control is.
4. **An arrived participant shows their check-in time and an undo control** —
   Assert the local time renders and the check-in control is absent.
5. **The check-in time renders in the cafe timezone** — Mock a UTC instant on
   the previous local day; assert the local time.
6. **Checking in calls the action with the participant id** — Assert the id,
   and that no timestamp is sent from the client.
7. **The control disables while pending** — Assert disabled during the
   transition, so a double-tap cannot fire twice.
8. **The row stays in place after success** — Assert the participant is still
   rendered, so the next person is not checked in by accident.
9. **`changed: false` renders "already checked in", not an error** — Mock a
   successful idempotent repeat; assert the message appears and that it is
   **not** presented as a failure.
10. **A CONFLICT refusal renders its message with the status** — Mock
    `ok: false` with `CONFLICT` naming `HELD`; assert `HELD` appears rather
    than a generic failure. **This is SC-07.**
11. **A refusal on one row does not disturb another** — Assert the other rows
    render unchanged, since one bad booking must not take the screen down mid
    queue.
12. **Undo calls the undo action with the participant id** — Assert the id.
13. **The roster is selected from `searchParams`** — Assert a given occurrence
    id renders that roster, so the view is linkable from `/staff/today`.
14. **The in-progress occurrence is selected by default** — With no
    `searchParams`, assert its roster renders rather than an empty chooser.
15. **An unknown occurrence id renders not-found rather than crashing** —
    Assert a graceful result.
16. **An empty roster renders a message** — Assert "nobody is booked" rather
    than an empty list.
17. **An unresolvable participant renders `'Unknown participant'`, not a blank
    row** — Assert the text is present. Phase 3 shipped blank rows here; this
    is the regression guard.
18. **The picker lists today's occurrences and marks the selected one** —
    Assert both.
19. **A day with no occurrences renders guidance, not an empty picker** —
    Assert the message links to `/staff/today`.
20. **The no-show control is rendered once per reservation, not per
    participant** — Mock one reservation with three participants; assert
    exactly one no-show control.
21. **No-show asks for confirmation first** — Assert a confirmation step
    precedes the action.
22. **The confirmation states that seats are released** — Assert the copy
    mentions releasing seats, since that consequence is invisible otherwise.
23. **No no-show control on a reservation with anyone checked in** — Assert
    absent, since the server refuses it.
24. **A no-show CONFLICT renders its message** — Mock `ok: false` with
    `CONFLICT`; assert the message renders rather than failing silently.

## Acceptance Criteria

1. `apps/web` and `packages/ui` pass all four scripts.
2. `/staff/check-in` lists an occurrence's participants by name with per-row
   check-in state and controls, and no longer renders `PlaceholderPanel`
   (tests 1–4). **SC-14.**
3. Checking in sends only the participant id; no timestamp originates on the
   client (test 6).
4. The control disables while pending and the row stays in place afterward
   (tests 7–8).
5. An idempotent repeat reads as "already checked in", not an error (test 9).
6. A refused check-in renders the reservation's current status from the
   server's message, and does not disturb neighbouring rows (tests 10–11).
   **SC-07.**
7. The roster is driven by `searchParams` and defaults to the in-progress
   occurrence (tests 13–14).
8. An empty roster, an unknown occurrence, and an unresolvable participant name
   all render gracefully — **never a blank row** (tests 15–17).
9. The no-show control is per reservation, confirmed, states that seats are
   released, and is absent once anyone has checked in (tests 20–23). **SC-08.**
10. Times render in the cafe's timezone (test 5).
11. `nav-config.test.ts` no longer treats `/staff/check-in` as a placeholder.
