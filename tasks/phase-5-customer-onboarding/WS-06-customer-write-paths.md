# WS-06: `customer-core` — real `addChild` and `updateHousehold`

## Goal

Turn two Phase-1 stubs into real commands.

`addChild` is the more consequential of the pair by a wide margin. Keki sells
classes for children, and today a parent has no way to tell the system their
child exists — children come from a seed script, so booking a kid into a class
requires a developer. `updateHousehold` is smaller: a household is named
`"Ada Lovelace Household"` at provisioning time and has never been changeable.

The governing constraint: **the household comes from the caller's session,
never from the payload.** A customer adding a child to a stranger's family is
the worst outcome this program can produce, and it is one missing line away.

## Traceability

- **SC-11** — A customer can add a child with a first name, last name, and date
  of birth.
- **SC-12** — A child is always added to the caller's own household, never one
  supplied in the payload.
- **SC-13** — Partially: rejects a future date of birth at the command as well
  as the schema.
- **SC-14** — A customer can rename their household.

## Dependencies

- **WS-01** — Contracts (`addChildSchema`, `updateHouseholdSchema`).

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Data access"; all database access goes through
  `packages/database`
- `docs/vision.md` — "Core Concepts"; Household and Child
- `packages/customer-core/src/commands.ts` — the two stubs, and
  `provisionCustomerProfile` beside them for the write style
- `packages/customer-core/src/queries.ts` — `listHouseholdMembers`,
  `getHouseholdById`
- `packages/database/src/schema/people.ts` — the `children` and `households`
  columns, including `date_of_birth`'s `date` type
- `packages/database/src/transaction.ts` — `withTransaction` and `Tx`
- `packages/contracts/src/onboarding.ts` — WS-01's schemas
- `packages/catalog-admin/src/errors.ts` — the typed-error style this follows
- `packages/staff-ops/src/check-in.ts` — Phase 4's command shape: session-derived
  actor, optional `tx`, typed errors

## Package

`packages/customer-core`

## Files Touched

- `packages/customer-core/src/commands.ts` (MODIFY — implement both)
- `packages/customer-core/src/errors.ts` (NEW — typed errors)
- `packages/customer-core/src/index.ts` (MODIFY — barrel)
- `packages/customer-core/src/commands.test.ts` (MODIFY — replace the stub assertions)
- `packages/customer-core/src/children.integration.test.ts` (NEW)

## Existing Interfaces to Consume

The two stubs, in full:

```ts
export function addChild(input: {
  householdId: HouseholdId;
  firstName: string;
  lastName: string;
  dateOfBirth: Date;
}): Promise<Child> {
  void input;
  return Promise.reject(new NotImplementedInPhase1('addChild'));
}

export function updateHousehold(input: { householdId: HouseholdId; name: string }): Promise<Household> {
  void input;
  return Promise.reject(new NotImplementedInPhase1('updateHousehold'));
}
```

> Both currently take `householdId` as a parameter. That is fine — the caller
> is a Server Action that has a session. What must never happen is that
> `householdId` originating in a **request payload**; WS-01 already makes it
> unrepresentable in the schemas, and WS-07 passes the session's value.

The tables:

```ts
export const children = pgTable('children', {
  id: uuid('id').primaryKey().defaultRandom(),
  householdId: uuid('household_id').notNull().references(() => households.id),
  firstName: text('first_name').notNull(),
  lastName: text('last_name').notNull(),
  dateOfBirth: date('date_of_birth').notNull(),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

The read that must reflect a new child immediately — it is what the booking
participant picker uses:

```ts
export async function listHouseholdMembers(
  householdId: HouseholdId,
): Promise<{ customers: readonly Customer[]; children: readonly Child[] }>;
```

The entity shape returned:

```ts
export interface Child {
  id: ChildId;
  householdId: HouseholdId;
  firstName: string;
  lastName: string;
  dateOfBirth: Date;
  createdAt: Date;
  updatedAt: Date;
}
```

## Implementation Steps

1. **Add typed errors** in `errors.ts`: `HouseholdNotFoundError` and
   `InvalidDateOfBirthError`. Follow the style `catalog-admin` and `staff-ops`
   established — a class per condition, carrying the value that made it fail.

2. **Implement `addChild`**:

   ```ts
   export async function addChild(input: {
     householdId: HouseholdId;
     firstName: string;
     lastName: string;
     dateOfBirth: Date;
     now?: Date;
     tx?: Tx;
   }): Promise<Child>;
   ```

   In order:

   a. Verify the household exists; throw `HouseholdNotFoundError` otherwise. A
      foreign-key violation would also stop the write, but it surfaces as an
      opaque Postgres error the UI cannot explain.

   b. **Re-check the date of birth is not in the future**, throwing
      `InvalidDateOfBirthError`. WS-01's schema already refuses it, but the
      schema guards the *HTTP boundary* and this command is also reachable from
      a seed script, a future kiosk surface, and a test. A domain invariant
      belongs in the domain.

   c. Insert and return the created row.

   `date_of_birth` is a `date` column, not a timestamp. Write the calendar date
   without a time component — a `Date` carrying 23:00 local can serialize to the
   next day in UTC and store a birthday one day off. Format explicitly as
   `YYYY-MM-DD` rather than handing Drizzle a `Date` and trusting the driver.

3. **Implement `updateHousehold`**:

   ```ts
   export async function updateHousehold(input: {
     householdId: HouseholdId;
     name: string;
     tx?: Tx;
   }): Promise<Household>;
   ```

   Throw `HouseholdNotFoundError` when the row is absent. Update `name` and
   `updated_at`, and return the updated row.

   **Do not touch `primary_customer_id`.** Changing who owns a household is a
   different operation with different consequences, and it is out of scope.

4. **Accept an optional `tx` on both**, matching the convention Phase 3 and
   Phase 4 established, so a caller composing several writes can share one
   transaction.

5. **Do not add an audit entry.** `staff_audit_log` records *staff* actions
   against catalog and reservations; a customer editing their own household is
   not a staff action, and `actor_customer_id` would be the household's own
   member. Customer-facing audit is a separate question this program does not
   open.

6. **Do not implement `startWaiverSigning`.** It sits in the same file and is
   equally a stub, but waivers are explicitly out of scope. Leave it rejecting.

7. **Replace the stub assertions** in `commands.test.ts`. Those tests currently
   assert both commands reject with `NotImplementedInPhase1`; leaving them would
   fail the build, and deleting them without replacement would silently drop
   coverage.

8. **Run all four scripts**, then `pnpm -r typecheck` and `pnpm test`
   workspace-wide.

## Tests

Database tests are `describe.skipIf(!hasLiveDatabase)` under a suite named
`integration: customer-core children`, isolated by per-test
`crypto.randomUUID()` identifiers rather than truncation.

1. **`addChild` creates a child in the named household** _(integration)_ —
   Assert the returned row's `householdId` equals the one passed and the names
   match. **This is SC-11.**
2. **The child appears in `listHouseholdMembers`** _(integration)_ — Assert it
   is returned, since that read is what the booking participant picker uses.
   A child that exists but is invisible there is useless.
3. **The child does not appear in another household's members** _(integration)_
   — Seed two households, add to one; assert the other's list is unchanged.
   **This is SC-12's proof at the data layer.**
4. **`addChild` stores the exact calendar date** _(integration)_ — Pass
   `2019-03-04` and assert the stored value reads back as `2019-03-04`, not
   the 3rd or the 5th. This is the timezone bug the `date` column invites.
5. **A late-evening local date does not shift a day** _(integration)_ — Pass a
   `Date` constructed at 23:30 local; assert the stored date is that same
   calendar day. The discriminating case for step 2's formatting rule.
6. **A future date of birth is refused** _(integration)_ — Pass tomorrow;
   assert `InvalidDateOfBirthError` and that no row was inserted. **SC-13** at
   the domain, not only the schema.
7. **Today's date is accepted** _(integration)_ — A child born today is real;
   assert success, proving the boundary is inclusive.
8. **An unknown household throws** _(integration)_ — Assert
   `HouseholdNotFoundError` rather than a raw foreign-key error, and that no
   row was inserted.
9. **`addChild` honours a supplied transaction** _(integration)_ — Insert
   inside a transaction and roll it back; assert no child row survives.
10. **Two children can share a name in one household** _(integration)_ — Twins
    exist; assert both insert rather than a uniqueness assumption creeping in.
11. **`updateHousehold` renames the household** _(integration)_ — Assert the
    returned and stored names are the new value. **This is SC-14.**
12. **It advances `updated_at`** _(integration)_ — Assert the timestamp moved,
    since a rename is a change worth dating.
13. **It leaves `primary_customer_id` untouched** _(integration)_ — Assert the
    value is unchanged. Household ownership is a different operation.
14. **It does not rename a different household** _(integration)_ — Seed two;
    assert only the target changed.
15. **An unknown household throws** _(integration)_ — Assert
    `HouseholdNotFoundError`.
16. **`updateHousehold` honours a supplied transaction** _(integration)_ —
    Roll back; assert the original name survives.
17. **Neither command writes to `staff_audit_log`** _(integration)_ — Assert
    the table is unchanged. A customer editing their own household is not a
    staff action.
18. **`startWaiverSigning` still rejects** — Assert it still throws
    `NotImplementedInPhase1`; waivers stay out of scope and this pins that.
19. **The stub assertions are gone** — Assert `commands.test.ts` no longer
    asserts `addChild` or `updateHousehold` reject with
    `NotImplementedInPhase1`, so the old coverage was replaced rather than
    left failing.

## Acceptance Criteria

1. `packages/customer-core` passes all four scripts, and `pnpm -r typecheck`
   and `pnpm test` pass workspace-wide.
2. `addChild` creates a child in the given household and it appears in
   `listHouseholdMembers` (tests 1–2). **SC-11.**
3. A child is never visible to another household (test 3). **SC-12.**
4. The stored date of birth is the exact calendar date, including for a
   late-evening local `Date` (tests 4–5).
5. A future date of birth is refused at the command, and today's is accepted
   (tests 6–7). **SC-13.**
6. An unknown household throws a typed error rather than a foreign-key
   violation (tests 8, 15).
7. Both commands honour an injected transaction (tests 9, 16).
8. `updateHousehold` renames only its target, advances `updated_at`, and leaves
   `primary_customer_id` alone (tests 11–14). **SC-14.**
9. Neither command writes an audit entry (test 17).
10. `startWaiverSigning` still rejects as a stub (test 18).
11. The Phase-1 stub assertions are replaced, not deleted or left failing
    (test 19).
