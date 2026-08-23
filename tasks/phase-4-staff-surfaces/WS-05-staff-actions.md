# WS-05: Staff Server Actions with the `FRONT_OF_HOUSE` boundary

## Goal

Expose the check-in commands to the staff UI as Server Actions, every one gated
on `FRONT_OF_HOUSE`.

Phase 2's WS-07 built `authenticatedAction` and defaulted it to `CUSTOMER`;
Phase 3 was the first caller to pass a staff role, `MANAGER`. This workstream
establishes the lower boundary — the one the kiosk surface will copy — and it
is the boundary most likely to be got wrong, because `FRONT_OF_HOUSE` is the
first role where "staff" and "can change the catalog" stop being the same
thing.

It ships no UI. WS-06, WS-07, and WS-08 build on it.

## Traceability

- **SC-13** — Every staff action rejects a caller whose role is below
  `FRONT_OF_HOUSE`.
- **SC-07** — Partially: maps the check-in refusal to a message a staff member
  can act on.
- **SC-09** — Partially: maps the invalid-transition refusal.

## Dependencies

- **WS-03** — `staff-ops` check-in commands.
- **WS-04** — `staff-ops` queries (the surfaces call them directly, and the
  actions revalidate their paths).

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Auth"; every `staff/` and `admin/` route requires an explicit
  role check
- `docs/vision.md` — "Target Users"; the Front of house persona and the role
  ladder
- `apps/web/app/actions/authenticated-action.ts` — the wrapper and its
  `requiredRole`, and why it authorizes before parsing
- `apps/web/app/actions/action-result.ts` — the `ActionResult` envelope and
  error codes
- `apps/web/app/actions/errors.ts` — the domain-error mapping this extends
- `apps/web/app/admin/actions/offering-actions.ts` — Phase 3's staff-role
  actions, the shape to mirror
- `apps/web/app/staff/layout.tsx` — the existing route-level
  `requireRole('FRONT_OF_HOUSE')`
- `packages/staff-ops/src/errors.ts` — WS-03's typed errors
- `packages/auth/src/authorize.ts` — `authorize` and the role-rank predicate
- `apps/web/app/nav-config.test.ts` — the placeholder brief and data-access
  allowlist

## Package

`apps/web`

## Files Touched

- `apps/web/app/staff/actions/check-in-actions.ts` (NEW)
- `apps/web/app/actions/errors.ts` (MODIFY — map staff-ops errors)
- `apps/web/app/staff/actions/check-in-actions.test.ts` (NEW)
- `apps/web/app/nav-config.test.ts` (MODIFY — allow staff data access)

## Existing Interfaces to Consume

The wrapper, which already supports the role this workstream needs. Note it
authorizes **before** parsing input:

```ts
export function authenticatedAction<TInput, TOutput>(
  config: AuthenticatedActionConfig<TInput, TOutput>,
): (raw: unknown) => Promise<ActionResult<TOutput>> {
  const requiredRole = config.requiredRole ?? DEFAULT_REQUIRED_ROLE;

  return async function run(raw: unknown): Promise<ActionResult<TOutput>> {
    // Resolve the session and authorize before parsing input: an
    // unauthenticated caller must not be able to probe validation behavior
    // to learn the shape of internal schemas.
    const result = await getSessionResult();
    const outcome = authorize({ result, requiredRole });
    if (!outcome.allowed) {
      return { ok: false, error: denialError(outcome) };
    }
    const parsed = config.schema.safeParse(raw);
    ...
```

The result envelope and its codes:

```ts
export type ActionResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: ActionError };

export const ACTION_ERROR_CODES = [
  'UNAUTHENTICATED', 'UNPROVISIONED', 'FORBIDDEN',
  'VALIDATION', 'CONFLICT', 'UNAVAILABLE', 'INTERNAL',
] as const;
```

The route-level guard already in place, which this complements rather than
replaces:

```ts
export default async function StaffLayout({ children }: { readonly children: ReactNode }) {
  await requireRole('FRONT_OF_HOUSE');
  ...
```

WS-03's commands, each returning a `changed` flag so an idempotent repeat is
distinguishable from a real change:

```ts
export async function checkInParticipant(input: {
  reservationParticipantId: ReservationParticipantId;
  actorCustomerId: CustomerId;
  now?: Date;
  tx?: Tx;
}): Promise<{ participantId: ReservationParticipantId; reservationId: ReservationId;
  checkedInAt: Date; reservationStatus: ReservationStatus; changed: boolean }>;

export async function markReservationNoShow(input: {
  reservationId: ReservationId;
  actorCustomerId: CustomerId;
  tx?: Tx;
}): Promise<{ reservationId: ReservationId; changed: boolean }>;
```

## Implementation Steps

1. **Write the three actions** in `check-in-actions.ts`, each wrapped in
   `authenticatedAction({ requiredRole: 'FRONT_OF_HOUSE', ... })`:

   - `checkInParticipantAction` — `checkInParticipantSchema`
   - `undoCheckInParticipantAction` — `undoCheckInParticipantSchema`
   - `markNoShowAction` — `markNoShowSchema`

   Pass `session.profile.customerId` as `actorCustomerId`. The audit trail is
   only as trustworthy as this — **never accept an actor id from the payload**.

   Do not pass `now`. The command defaults it from the server clock; exposing
   it here would let a caller backdate an attendance record through an action
   that a browser can invoke directly.

2. **Return the `changed` flag through the envelope.** An idempotent repeat is
   a success, not a failure, and the UI needs to tell "already checked in" from
   "just checked in" without guessing.

3. **Call `revalidatePath`** for `/staff/today`, `/staff/check-in`, and
   `/staff/occupancy` after any mutation.

   `/staff/occupancy` matters and is easy to miss: checking someone in changes
   the headcount, and a staff member who checks a group in and then walks to
   the occupancy screen should see them. Note in a comment that these pages are
   dynamic, so this is belt and braces rather than strictly required.

4. **Map the `staff-ops` errors** in `errors.ts`, extending the existing
   mapping rather than replacing it:

   - `ReservationNotCheckInEligibleError` → `CONFLICT`, **naming the current
     status** — "this booking is still an unfinished checkout" is actionable,
     "cannot check in" is not
   - `InvalidReservationTransitionError` → `CONFLICT`, naming both states
   - `ReservationParticipantNotFoundError` → `VALIDATION`
   - `ReservationNotFoundError` → `VALIDATION`

   Keep the existing rule that an unmapped error yields a generic `INTERNAL`
   message and logs the original server-side. These messages reach a browser.

5. **Update `nav-config.test.ts`** to allow data access under
   `staff${sep}actions${sep}`, on the same terms as the other sanctioned
   boundaries. Do not exempt the staff pages themselves yet — WS-06 through
   WS-08 do that as each is built.

6. **Do not remove the layout guard.** Two independent checks — the
   route-level `requireRole('FRONT_OF_HOUSE')` and the per-action
   `requiredRole` — are what makes a missed one survivable. A Server Action is
   directly invocable by anyone who can construct the request; the layout does
   not protect it.

7. **Run all four scripts.**

## Tests

Vitest with `@keki/staff-ops` and `@keki/auth` mocked at the module boundary,
mirroring `apps/web/app/admin/actions/offering-actions.test.ts`.

1. **A CUSTOMER is rejected by every action** — For each of the three actions,
   authorize as `CUSTOMER`; assert `ok: false` with code `FORBIDDEN` and that
   the underlying command was **never called**. **This is SC-13, and it must
   cover every action rather than a representative one.**
2. **An anonymous caller is rejected** — Assert `UNAUTHENTICATED` and no
   command call.
3. **An unprovisioned caller is rejected** — A valid token with no `customers`
   row; assert `UNPROVISIONED` and no command call.
4. **A FRONT_OF_HOUSE caller is allowed** — Assert the command is called and
   `ok: true`. This is the boundary this workstream exists to establish.
5. **A MANAGER caller is allowed** — Assert allowed, since `FRONT_OF_HOUSE` is
   a floor and not an equality check.
6. **An ADMIN caller is allowed** — Assert the same, covering the top of the
   ladder.
7. **Authorization precedes validation** — Call as `CUSTOMER` with a payload
   that would also fail the schema; assert the code is `FORBIDDEN`, not
   `VALIDATION`, proving ordering.
8. **The actor comes from the session, not the payload** — Send a payload
   carrying a different `actorCustomerId`; assert the command received the
   **session's** `customerId`. Without this the audit trail is forgeable.
9. **`now` is never forwarded from the payload** — Send a payload carrying
   `now` and `checkedInAt`; assert the command was called without either, so an
   attendance record cannot be backdated through the action.
10. **`checkInParticipantAction` passes the parsed participant id** — Assert
    the command received exactly the uuid supplied.
11. **A malformed uuid yields VALIDATION** — Assert the code and that no
    command ran.
12. **`changed: false` is returned as a success** — Mock an idempotent repeat;
    assert `ok: true` with `changed: false`, not an error. The UI must be able
    to say "already checked in".
13. **`ReservationNotCheckInEligibleError` maps to CONFLICT with the status** —
    Assert the code and that the message contains `HELD`, so the surface can
    explain the refusal. **SC-07.**
14. **`InvalidReservationTransitionError` maps to CONFLICT naming both
    states** — Assert both appear in the message. **SC-09.**
15. **`ReservationParticipantNotFoundError` maps to VALIDATION** — Assert the
    code.
16. **An unmapped error yields a generic INTERNAL message** — Throw an error
    whose message contains `postgresql://user:password@host`; assert the
    envelope's message does **not** contain it and the code is `INTERNAL`.
17. **Mutations revalidate `/staff/occupancy`** — Assert `revalidatePath` was
    called for it after a check-in, since that is the screen a staff member
    walks to next.
18. **Mutations revalidate `/staff/today`** — Assert the same, since the
    arrived count changes.
19. **The layout guard is still present** — Assert `staff/layout.tsx` still
    calls `requireRole('FRONT_OF_HOUSE')`, so the second line of defense cannot
    be removed silently.

## Acceptance Criteria

1. `apps/web` passes all four scripts.
2. Every one of the three actions rejects `CUSTOMER`, anonymous, and
   unprovisioned callers, and admits `FRONT_OF_HOUSE`, `MANAGER`, and `ADMIN`
   (tests 1–6). **SC-13.**
3. Authorization runs before input parsing (test 7).
4. `actorCustomerId` always comes from the session and can never be supplied by
   the caller (test 8).
5. Neither `now` nor `checkedInAt` can reach the command from the payload
   (test 9).
6. An idempotent repeat returns `ok: true` with `changed: false` rather than an
   error (test 12).
7. Every `staff-ops` error maps to a code with a message a staff member can act
   on, including the current status on a refused check-in (tests 13–15).
8. Unmapped errors return a generic message and never leak the original text
   (test 16).
9. Mutations revalidate all three staff paths (tests 17–18).
10. The route-level `requireRole('FRONT_OF_HOUSE')` remains, giving two
    independent enforcement points (test 19).
11. No UI is added in this workstream.
