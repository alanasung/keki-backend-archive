# WS-01: Contracts — profile, child, and household schemas; OAuth handshake types

## Goal

Add the vocabulary this program needs: input schemas for completing a profile,
adding a child, and renaming a household, plus the types the OAuth handshake
passes between the auth library and the routes that drive it.

The schemas carry two constraints that are the whole point of putting them
here. `addChildSchema` must make `householdId` **unrepresentable** — a child is
added to the caller's own household, taken from the session, never from a
payload. And a date of birth in the future must fail at the parse, not reach a
`notNull date` column that will happily store it.

Types and schemas only. No runtime behavior beyond schema definitions.

## Traceability

- **SC-12** — Partially: makes `householdId` unrepresentable as an input, so a
  child cannot be added to a household the caller does not own. WS-06 enforces
  the session-derived household.
- **SC-13** — A future date of birth is refused.
- **SC-11** — Partially: defines the shape `addChild` accepts.
- **SC-14** — Partially: defines the household rename input.
- **SC-01** — Partially: defines the authorization-request type the URL builder
  produces.

## Dependencies

None. This is a root of the program, alongside WS-02.

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Module boundaries"; a type crossing a package boundary belongs
  in `contracts`, not duplicated at both ends
- `docs/vision.md` — "Core Concepts"; Household, Child, Customer
- `packages/contracts/src/staff.ts` — Phase 4's schema module, the structure
  and strictness convention this mirrors
- `packages/contracts/src/admin.ts` — Phase 3's schemas, for the same
  convention
- `packages/contracts/src/entities.ts` — `Child`, `Household`, `Customer`
- `packages/database/src/schema/people.ts` — the `children` and `households`
  columns these schemas describe, including `date_of_birth`'s type
- `packages/auth/src/session.ts` — `CustomerProfile` and `Session`, which the
  handshake types sit alongside
- `packages/contracts/src/index.ts` — the barrel

## Package

`packages/contracts`

## Files Touched

- `packages/contracts/src/onboarding.ts` (NEW) — profile, child, and household schemas
- `packages/contracts/src/oauth.ts` (NEW) — authorization request, token response, PKCE pair
- `packages/contracts/src/index.ts` (MODIFY — export both modules)
- `packages/contracts/src/onboarding.test.ts` (NEW)
- `packages/contracts/src/oauth.test.ts` (NEW)

## Existing Interfaces to Consume

The `children` table. Note `date_of_birth` is a `date` column, not a
timestamp — a birthday has no time of day, and storing one invites timezone
bugs on a value that is the same everywhere:

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

The entity shapes these produce:

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

export interface Household {
  id: HouseholdId;
  primaryCustomerId: CustomerId;
  createdAt: Date;
  updatedAt: Date;
}
```

The Phase 4 schema convention this mirrors — strict parsing, and inputs the
command derives are omitted rather than made optional:

```ts
export const checkInParticipantSchema = z.object({
  reservationParticipantId: z.string().uuid(),
}).strict();
```

The session the household will be taken from, so the schemas do not have to
carry it:

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

## Implementation Steps

1. **Add the profile-completion schema** in `onboarding.ts`:

   ```ts
   export const completeProfileSchema = z.object({
     firstName: z.string().trim().min(1).max(80),
     lastName: z.string().trim().min(1).max(80),
   }).strict();

   export type CompleteProfileInput = z.infer<typeof completeProfileSchema>;
   ```

   `email` is **not** an input. It comes from the verified id token, and
   accepting it would let a caller claim an address they do not control — the
   one field in this program where a forged value has real consequences,
   because `customers.email` is `citext unique` and is how staff find people.

   `cognitoSub` is not an input for the same reason, and more so: it is the
   identity itself.

2. **Add the child schema**:

   ```ts
   export const addChildSchema = z.object({
     firstName: z.string().trim().min(1).max(80),
     lastName: z.string().trim().min(1).max(80),
     dateOfBirth: z.coerce.date(),
   }).strict();

   export type AddChildInput = z.infer<typeof addChildSchema>;
   ```

   **`householdId` is absent, deliberately.** The command takes it from the
   session. If it were an input, a customer could add a child to a stranger's
   family by editing a form field — and `.strict()` is what turns the attempt
   into a parse failure rather than a silently ignored key.

   `z.coerce.date()` because a date input arrives as a string.

3. **Refuse an impossible date of birth.** Add a refinement rejecting a date in
   the future, and one rejecting a date before 1900:

   ```ts
   .refine((value) => value <= new Date(), { message: 'Date of birth cannot be in the future.' })
   ```

   The future check is the one that matters — age decides which class a child
   belongs in, and a future birthday makes that arithmetic negative. The 1900
   floor catches a mistyped year (`0202` for `2020`) that would otherwise store
   a two-thousand-year-old child.

   > Apply the refinements to the `dateOfBirth` field, not the whole object,
   > so the field error lands on the right form control.

4. **Add the household rename schema**:

   ```ts
   export const updateHouseholdSchema = z.object({
     name: z.string().trim().min(1).max(120),
   }).strict();
   ```

   `householdId` is absent for the same reason as the child's.

5. **Add the OAuth handshake types** in `oauth.ts`. These are the values the
   auth library and the routes hand each other:

   ```ts
   export interface PkcePair {
     readonly verifier: string;
     readonly challenge: string;
   }

   export interface AuthorizationRequest {
     readonly url: string;
     readonly state: string;
     readonly verifier: string;
   }

   export const cognitoTokenResponseSchema = z.object({
     id_token: z.string().min(1),
     access_token: z.string().min(1),
     refresh_token: z.string().min(1).optional(),
     expires_in: z.number().int().positive(),
     token_type: z.string(),
   }).passthrough();

   export type CognitoTokenResponse = z.infer<typeof cognitoTokenResponseSchema>;
   ```

   **`refresh_token` is optional** because Cognito omits it on a refresh
   exchange — it returns a new id token and reuses the existing refresh token.
   Requiring it would make every refresh fail.

   **`.passthrough()`, not `.strict()`**, and this is the one schema in the
   program where that is right: the token response comes from Cognito, not from
   a user, and rejecting it because AWS added a field would break sign-in for
   everyone at a moment of their choosing.

6. **Export from the barrel** and run all four scripts, then `pnpm -r typecheck`.

## Tests

All pure; no database.

1. **`completeProfileSchema` accepts a first and last name** — Assert a valid
   input parses and yields exactly those two fields.
2. **`completeProfileSchema` rejects a supplied email** — Parse an input
   carrying `email`; assert failure. This is what keeps the verified token
   authoritative for identity.
3. **`completeProfileSchema` rejects a supplied cognitoSub** — Assert failure.
4. **Names are trimmed and non-empty** — Assert `'   '` fails and `'  Ada '`
   parses to `'Ada'`.
5. **`addChildSchema` rejects a supplied householdId** — Parse an input
   carrying `householdId`; assert failure. **This is SC-12's first line of
   defense**, and the test that proves `.strict()` is doing work.
6. **`addChildSchema` coerces an ISO date string** — Assert a string input
   yields a `Date`, since form submissions arrive as strings.
7. **A future date of birth is refused** — Pass tomorrow's date; assert
   failure and that the issue path is `dateOfBirth`. **This is SC-13.**
8. **Today's date is accepted** — A child born today is a real, if unusual,
   case; assert it parses, proving the boundary is `<=` and not `<`.
9. **A date before 1900 is refused** — Assert failure, catching a mistyped
   year.
10. **A date in 1995 is accepted** — The discriminating half of test 9: an
    implementation that rejects everything passes test 9 alone.
11. **`updateHouseholdSchema` rejects a supplied householdId** — Assert
    failure.
12. **`updateHouseholdSchema` trims and bounds the name** — Assert `'  Smith '`
    parses to `'Smith'` and a 121-character name fails.
13. **`cognitoTokenResponseSchema` accepts a response without a refresh
    token** — Assert it parses. Cognito omits it on refresh, and requiring it
    would break every refresh.
14. **`cognitoTokenResponseSchema` accepts unknown fields** — Add
    `scope: 'openid'`; assert it parses and the field survives. Rejecting an
    added AWS field would break sign-in for everyone at once.
15. **`cognitoTokenResponseSchema` rejects a missing id_token** — Assert
    failure; the id token is the only part the session actually needs.
16. **`cognitoTokenResponseSchema` rejects a non-numeric expires_in** — Assert
    failure, since the refresh deadline is computed from it.

## Acceptance Criteria

1. `packages/contracts` passes all four scripts, and `pnpm -r typecheck` passes
   workspace-wide.
2. `completeProfileSchema` makes `email` and `cognitoSub` **unrepresentable**
   as inputs (tests 2–3).
3. `addChildSchema` makes `householdId` unrepresentable (test 5). **SC-12.**
4. A future date of birth is refused, with the error on the `dateOfBirth`
   field, while today's date is accepted (tests 7–8). **SC-13.**
5. An implausibly old date is refused and an ordinary one accepted (tests
   9–10).
6. `updateHouseholdSchema` makes `householdId` unrepresentable (test 11).
7. Every user-supplied schema parses strictly, rejecting unknown keys rather
   than stripping them.
8. `cognitoTokenResponseSchema` is the one exception — it passes unknown
   fields through and treats `refresh_token` as optional (tests 13–14).
9. No runtime behavior beyond schema and type definitions is added.
