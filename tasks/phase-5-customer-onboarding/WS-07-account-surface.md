# WS-07: `/account` — add a child and rename the household

## Goal

Make `/account` editable. Today it renders household members and order history
behind a doc comment that says, in effect, *we would let you change this but the
commands are stubs*:

> Read-only by design. Editing a household, adding a child, buying or
> [redeeming a pass] … all depend on commands that still reject with
> `NotImplementedInPhase1` (customer-core's `addChild` and `updateHousehold`,
> every command in pass-core, `startWaiverSigning`).

WS-06 removes exactly two of those blockers. This workstream spends them: a
parent can add their child and rename their household. The rest of that comment
stays true, and the comment should be updated to say which parts still are.

The payoff is not on this page. It is that the child then appears in the
booking participant picker — which is what turns "a customer has an account"
into "a customer can buy the thing this business sells."

## Traceability

- **SC-11** — Partially: the form that adds a child. WS-06 performs the write.
- **SC-12** — Partially: passes the household from the session, never a form
  field.
- **SC-13** — Partially: surfaces the future-date refusal.
- **SC-14** — Partially: the household rename control.
- **SC-15** — Partially: a newly added child becomes a bookable participant.
  WS-09 proves it end to end.

## Dependencies

- **WS-06** — `customer-core`'s real `addChild` and `updateHousehold`.

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Auth" and "Module boundaries"; `packages/ui` is presentational
- `docs/vision.md` — "Target Users"; the Customer persona
- `apps/web/app/(customer)/account/page.tsx` — the page being changed, and the
  doc comment explaining why it is read-only
- `apps/web/app/(customer)/book/participant-picker.tsx` — where a child becomes
  bookable, and the shape it expects
- `apps/web/app/actions/authenticated-action.ts` — the wrapper, and its
  `requiredRole` default of `CUSTOMER`
- `apps/web/app/actions/errors.ts` — the domain-error mapping this extends
- `packages/customer-core/src/commands.ts` — WS-06's commands
- `packages/customer-core/src/queries.ts` — `listHouseholdMembers`
- `packages/ui/src/components/form-field.tsx` — Phase 3's field
- `packages/ui/src/components/empty-state.tsx` — the empty state

## Package

`apps/web`

## Files Touched

- `apps/web/app/(customer)/account/page.tsx` (MODIFY — add the editable sections)
- `apps/web/app/(customer)/account/add-child-form.tsx` (NEW — client island)
- `apps/web/app/(customer)/account/household-name-form.tsx` (NEW — client island)
- `apps/web/app/(customer)/account/account-actions.ts` (NEW)
- `apps/web/app/actions/errors.ts` (MODIFY — map customer-core errors)
- `apps/web/app/(customer)/account/page.test.tsx` (MODIFY)
- `apps/web/app/(customer)/account/account-actions.test.ts` (NEW)

## Existing Interfaces to Consume

The wrapper every mutation goes through. Its default `requiredRole` is
`CUSTOMER`, which is exactly right here — unlike WS-05's action, this one runs
only for a provisioned customer:

```ts
export function authenticatedAction<TInput, TOutput>(
  config: AuthenticatedActionConfig<TInput, TOutput>,
): (raw: unknown) => Promise<ActionResult<TOutput>> {
  const requiredRole = config.requiredRole ?? DEFAULT_REQUIRED_ROLE;   // 'CUSTOMER'

  return async function run(raw: unknown): Promise<ActionResult<TOutput>> {
    const result = await getSessionResult();
    const outcome = authorize({ result, requiredRole });
    if (!outcome.allowed) {
      return { ok: false, error: denialError(outcome) };
    }
    const parsed = config.schema.safeParse(raw);
    ...
```

The session the household id comes from:

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

WS-06's commands:

```ts
export async function addChild(input: {
  householdId: HouseholdId;
  firstName: string;
  lastName: string;
  dateOfBirth: Date;
  now?: Date;
  tx?: Tx;
}): Promise<Child>;

export async function updateHousehold(input: {
  householdId: HouseholdId;
  name: string;
  tx?: Tx;
}): Promise<Household>;
```

WS-01's schemas, which omit `householdId` deliberately:

```ts
export const addChildSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  dateOfBirth: z.coerce.date(),  // refined: not future, not before 1900
}).strict();

export const updateHouseholdSchema = z.object({
  name: z.string().trim().min(1).max(120),
}).strict();
```

## Implementation Steps

1. **Write the actions** in `account-actions.ts`, both wrapped in
   `authenticatedAction` at its default `CUSTOMER` role:

   - `addChildAction` — `addChildSchema`
   - `updateHouseholdNameAction` — `updateHouseholdSchema`

   **Take `householdId` from `session.profile.householdId`.** This is the whole
   security property of the workstream. WS-01 makes it unrepresentable in the
   payload and this is where the real value comes from; the two together are
   what make SC-12 true.

   `householdId` is `HouseholdId | null` on the profile. A provisioned customer
   always has one, but the type does not know that — return a `VALIDATION`
   error rather than asserting non-null, so a genuinely null value surfaces as
   a handled case instead of a crash.

2. **Call `revalidatePath`** for `/account` and `/book` after a successful
   `addChild`. `/book` matters and is the easy one to miss: the participant
   picker lists household children, and a parent who adds a child and goes
   straight to booking should find them there. **SC-15.**

3. **Map the customer-core errors** in `errors.ts`, extending the existing
   mapping:

   - `InvalidDateOfBirthError` → `VALIDATION`, naming the constraint
   - `HouseholdNotFoundError` → `VALIDATION`

   Keep the existing rule that an unmapped error yields a generic `INTERNAL`
   message and logs the original server-side.

4. **Build the add-child form** in `add-child-form.tsx` as a `'use client'`
   island: first name, last name, date of birth. Use `FormField`, disable the
   control while pending via `useTransition`, and render `result.error.message`
   on failure.

   Use `<input type="date">` so the browser supplies a date picker and a
   `YYYY-MM-DD` value — the format WS-01's `z.coerce.date()` parses
   unambiguously. A free-text date field invites `03/04/2019`, which is March
   or April depending on the reader.

   **Set a `max` of today** on the input. The schema and the command both
   refuse a future date; the input attribute means most people never hit either.
   All three layers are deliberate — the attribute is a courtesy, not the
   guard.

   Clear the form on success, so adding a second child does not require
   deleting the first one's name.

5. **Build the household rename** in `household-name-form.tsx`, another client
   island: a text field pre-filled with the current name and a save control.
   Show a confirmation on success — a rename with no feedback reads as a
   no-op.

6. **Wire both into the page.** Keep the existing read-only sections; add the
   forms alongside. Render the children list from `listHouseholdMembers` so a
   newly added child appears immediately after revalidation.

   When the household has no children, render an `EmptyState` that says adding
   one is how you book a class for them — this is the page's most important
   empty state, because a customer who cannot work out how to add a child
   cannot buy anything.

7. **Update the page's doc comment.** It currently attributes read-only-ness to
   four stubs, two of which WS-06 just implemented. Leaving it would make a
   future reader believe `addChild` is still unavailable. Say what remains:
   pass purchase and redemption, and waiver signing.

8. **Do not add child editing or deletion.** Out of scope, and both raise
   questions this program does not answer — what happens to a child already
   booked into a class.

9. **Run all four scripts.**

## Tests

Vitest with `@keki/customer-core` and the actions mocked at the module
boundary.

1. **The add-child form renders its three fields** — Assert first name, last
   name, and date of birth are present.
2. **The date field is `type="date"`** — Assert the attribute, so the value
   arrives as unambiguous `YYYY-MM-DD`.
3. **The date field's `max` is today** — Assert the attribute equals today's
   date, so a future birthday is hard to enter in the first place.
4. **Submitting calls the action with parsed values** — Assert the names and a
   date value the schema can coerce.
5. **The form sends no `householdId`** — Assert the payload has no such key.
   **This is SC-12** at the client boundary.
6. **The action passes the session's household to the command** — Assert
   `addChild` received `session.profile.householdId`, not anything from the
   payload.
7. **A payload-supplied `householdId` is ignored** — Send one for a different
   household; assert the command received the session's. A customer adding a
   child to a stranger's family is the worst outcome this program can produce.
8. **A null household on the profile yields VALIDATION, not a crash** — Mock
   `householdId: null`; assert a handled error and no command call.
9. **A future date is refused with a message** — Mock the command throwing
   `InvalidDateOfBirthError`; assert `VALIDATION` and that the message names the
   constraint. **SC-13.**
10. **The form clears on success** — Assert the name fields are empty
    afterward, so adding a second child does not require clearing the first.
11. **The submit control disables while pending** — Assert it is disabled
    during the transition, so a double-click cannot add twice.
12. **A failed add renders its message** — Mock `ok: false`; assert the message
    appears rather than a silent failure.
13. **Adding a child revalidates `/book`** — Assert `revalidatePath` was called
    for it. **This is SC-15's mechanism**; without it a parent adds a child and
    cannot find them when booking.
14. **Adding a child revalidates `/account`** — Assert the same, so the list
    updates.
15. **The children list renders existing children by name** — Mock two; assert
    both names appear.
16. **A household with no children renders guidance, not an empty list** —
    Assert the empty state mentions adding a child, since this is the page's
    most consequential empty state.
17. **The rename form pre-fills the current name** — Assert the default value.
18. **Renaming calls the action with the trimmed name** — Assert the exact
    value.
19. **The rename form sends no `householdId`** — Assert the payload has no such
    key. **SC-12.**
20. **A successful rename shows confirmation** — Assert feedback appears; a
    silent rename reads as a no-op.
21. **A blank name is refused** — Submit `'  '`; assert `VALIDATION` and no
    command call.
22. **No child edit or delete control is rendered** — Assert neither exists,
    since both are out of scope and the commands do not exist.
23. **The page's doc comment no longer lists `addChild` as a stub** — Assert
    the file does not claim `addChild` or `updateHousehold` still reject with
    `NotImplementedInPhase1`, so a future reader is not misled.

## Acceptance Criteria

1. `apps/web` passes all four scripts.
2. `/account` renders an add-child form with a `type="date"` field capped at
   today (tests 1–3).
3. Neither form sends a `householdId`, and the actions take it from the session
   — a payload-supplied one is ignored (tests 5–7, 19). **SC-12.**
4. A null household on the profile is a handled validation error, not a crash
   (test 8).
5. A future date of birth surfaces a message naming the constraint (test 9).
   **SC-13.**
6. Adding a child revalidates both `/account` and `/book` (tests 13–14).
   **SC-15.**
7. The form clears on success and disables while pending (tests 10–11).
8. A household with no children is told how to add one (test 16).
9. The household rename works, is confirmed, and refuses a blank name
   (tests 17–21). **SC-14.**
10. No child edit or delete control is added (test 22).
11. The page's doc comment is updated so it no longer names implemented
    commands as stubs (test 23).
