# WS-05: Admin Server Actions with the `MANAGER` boundary

## Goal

Expose the catalog commands to the admin UI as Server Actions, every one gated
on `MANAGER`.

WS-07 of the previous program built `authenticatedAction` and defaulted it to
`CUSTOMER`; it already accepts a `requiredRole` that nothing has used yet. This
workstream is the first caller to pass a staff role, and it establishes the
admin mutation shape that the staff and kiosk surfaces will copy.

It ships no UI. WS-06, WS-07, and WS-08 build on it.

## Traceability

- **SC-12** — Every admin action rejects a caller whose role is below
  `MANAGER`.
- **SC-01** — Partially: exposes `createOffering` to the surface that calls it.
- **SC-09** — Partially: maps the cancellation refusal to a message a manager
  can act on.

## Dependencies

- **WS-02** — catalog-admin offering commands.
- **WS-03** — catalog-admin occurrence commands.

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Auth"; every `staff/` and `admin/` route requires an explicit
  role check
- `docs/vision.md` — "Target Users"; the Manager/Admin persona
- `apps/web/app/actions/authenticated-action.ts` — the wrapper and its
  `requiredRole`
- `apps/web/app/actions/action-result.ts` — the `ActionResult` envelope and
  error codes
- `apps/web/app/actions/errors.ts` — the domain-error mapping this extends
- `apps/web/app/admin/layout.tsx` — the existing route-level `requireRole('MANAGER')`
- `packages/catalog-admin/src/errors.ts` — the typed errors to map
- `packages/auth/src/session.ts` — `Session` and `CustomerProfile`

## Package

`apps/web`

## Files Touched

- `apps/web/app/admin/actions/offering-actions.ts` (NEW)
- `apps/web/app/admin/actions/occurrence-actions.ts` (NEW)
- `apps/web/app/actions/errors.ts` (MODIFY — map catalog-admin errors)
- `apps/web/app/admin/actions/offering-actions.test.ts` (NEW)
- `apps/web/app/admin/actions/occurrence-actions.test.ts` (NEW)
- `apps/web/app/nav-config.test.ts` (MODIFY — allow admin data access)

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

The session shape the actions pass through as `actorCustomerId`:

```ts
export interface CustomerProfile {
  readonly customerId: CustomerId;
  readonly householdId: HouseholdId | null;
  readonly email: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly role: Role;
}
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

The route-level guard already in place, which this workstream complements
rather than replaces:

```ts
export default async function AdminLayout({ children }: { readonly children: ReactNode }) {
  await requireRole('MANAGER');
  ...
```

## Implementation Steps

1. **Write the offering actions** in `offering-actions.ts`, each wrapped in
   `authenticatedAction({ requiredRole: 'MANAGER', ... })`:

   - `createOfferingAction` — `createOfferingSchema`
   - `updateOfferingAction` — offering id plus `updateOfferingSchema`
   - `publishOfferingAction`, `unpublishOfferingAction`, `archiveOfferingAction`
     — offering id only; the target status is fixed by the action, never
     supplied by the caller

   Three separate transition actions rather than one taking a target status.
   A single `setStatusAction` would accept `ARCHIVED` from any caller who can
   reach it, and the guard would then rest entirely on the transition table.
   Fixing the target in the action name means an attacker cannot choose it.

   Pass `session.profile.customerId` as `actorCustomerId`. The audit trail is
   only as trustworthy as this — never accept an actor id from the payload.

2. **Write the occurrence actions** in `occurrence-actions.ts`:
   `scheduleOccurrenceAction`, `updateOccurrenceAction`,
   `cancelOccurrenceAction`.

   `updateOccurrenceAction` returns the `bookedSeats` count from WS-03 so the
   UI can warn when capacity was lowered below it. Return it always, not only
   when it exceeds capacity — the caller decides what warrants a warning.

3. **Call `revalidatePath`** for `/admin/offerings`, `/admin/schedules`, and
   `/book` after any mutation that changes what those pages show.

   `/book` matters and is easy to miss: publishing a class or scheduling an
   occurrence changes the customer surface, and a manager who publishes and
   then checks `/book` should see it. `/book` is `force-dynamic`, so this is
   belt and braces rather than strictly required — note that in a comment so a
   later reader knows it is deliberate.

4. **Map the catalog-admin errors** in `errors.ts`, extending the existing
   mapping rather than replacing it:

   - `InvalidOfferingTransitionError` → `CONFLICT`, naming both states
   - `OccurrenceHasReservationsError` → `CONFLICT`, **including the count** —
     "3 people are booked" is actionable; "cannot cancel" is not
   - `OccurrenceInPastError` → `VALIDATION`
   - `OverlappingOccurrenceError` → `CONFLICT`, naming the conflicting start
   - `OfferingNotPublishedError` → `CONFLICT`
   - `OfferingNotFoundError` / `OccurrenceNotFoundError` → `VALIDATION`
   - `UnsupportedOfferingTypeError` → `VALIDATION`

   Keep the existing rule that an unmapped error yields a generic `INTERNAL`
   message and logs the original server-side. These messages reach a browser.

5. **Update `nav-config.test.ts`** to allow data access under
   `admin${sep}actions${sep}`, on the same terms as the other sanctioned
   boundaries. Do not exempt the admin pages themselves yet — WS-06 through
   WS-08 do that as each is built.

6. **Do not remove the layout guard.** Two independent checks — the route-level
   `requireRole('MANAGER')` and the per-action `requiredRole` — are what makes
   a missed one survivable. A Server Action is directly invocable by anyone who
   can construct the request; the layout does not protect it.

7. **Run all four scripts.**

## Tests

Vitest with `@keki/catalog-admin` and `@keki/auth` mocked at the module
boundary, mirroring `apps/web/app/actions/authenticated-action.test.ts`.

1. **A CUSTOMER is rejected by every action** — For each of the eight actions,
   authorize as `CUSTOMER`; assert `ok: false` with code `FORBIDDEN` and that
   the underlying command was never called. **This is SC-12, and it must cover
   every action rather than a representative one.**
2. **An anonymous caller is rejected** — Assert `UNAUTHENTICATED` and no
   command call.
3. **A FRONT_OF_HOUSE caller is rejected** — Assert `FORBIDDEN`. Staff are not
   managers, and this is the boundary most likely to be got wrong.
4. **A MANAGER is allowed** — Assert the command is called and `ok: true`.
5. **An ADMIN is allowed** — Assert the same, since `MANAGER` is a floor and
   not an equality check.
6. **Authorization precedes validation** — Call as `CUSTOMER` with a payload
   that would also fail the schema; assert the code is `FORBIDDEN`, not
   `VALIDATION`, proving ordering.
7. **The actor comes from the session, not the payload** — Send a payload
   carrying a different `actorCustomerId`; assert the command received the
   session's `customerId`. Without this the audit trail is forgeable.
8. **`createOfferingAction` passes parsed input through** — Assert the command
   received the parsed values.
9. **Transition actions fix their target status** — Assert
   `publishOfferingAction` calls the command with `to: 'PUBLISHED'` and that a
   payload carrying `to: 'ARCHIVED'` cannot change it.
10. **`InvalidOfferingTransitionError` maps to CONFLICT** — Assert the code and
    that the message names both states.
11. **`OccurrenceHasReservationsError` maps to CONFLICT with the count** —
    Assert the message contains the booked count, so the UI can explain the
    refusal.
12. **`OccurrenceInPastError` maps to VALIDATION** — Assert the code.
13. **`OverlappingOccurrenceError` maps to CONFLICT** — Assert the code and
    that the message names the conflicting start time.
14. **An unmapped error yields a generic INTERNAL message** — Throw an error
    whose message contains `postgresql://user:password@host`; assert the
    envelope's message does **not** contain it and the code is `INTERNAL`.
15. **`updateOccurrenceAction` returns bookedSeats** — Assert it is present in
    the success payload even when capacity was not lowered.
16. **Mutations revalidate `/book`** — Assert `revalidatePath` was called for
    `/book` after publishing, since that is the surface a manager checks next.
17. **The layout guard is still present** — Assert `admin/layout.tsx` still
    calls `requireRole('MANAGER')`, so the second line of defense cannot be
    removed silently.

## Acceptance Criteria

1. `apps/web` passes all four scripts.
2. Every one of the eight actions rejects `CUSTOMER`, `FRONT_OF_HOUSE`, and
   anonymous callers, and admits `MANAGER` and `ADMIN` (tests 1–5). **SC-12.**
3. Authorization runs before input parsing (test 6).
4. `actorCustomerId` always comes from the session and can never be supplied by
   the caller (test 7).
5. Publish, unpublish, and archive are separate actions with fixed target
   statuses; no action accepts a caller-chosen status (test 9).
6. Every `catalog-admin` error maps to a code with a message a manager can act
   on, and the cancellation refusal includes the booked count (tests 10–13).
7. Unmapped errors return a generic message and never leak the original text
   (test 14).
8. `updateOccurrenceAction` always returns `bookedSeats`.
9. The route-level `requireRole('MANAGER')` remains, giving two independent
   enforcement points (test 17).
10. No UI is added in this workstream.
