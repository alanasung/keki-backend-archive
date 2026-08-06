# WS-04: Auth — Cognito identity and Postgres role model

## Goal

Create `@keki/auth`: Cognito JWT verification, session resolution, and the
lookup that joins a Cognito subject to a `customers` row carrying the
application role. This package defines **one** authorization predicate that
WS-09 consumes; it does not itself protect any route.

The split is the point: Cognito owns authentication, Postgres owns profiles and
role assignment. This package is the only seam where the two meet.

## Traceability

- **SC-12** — The four roles exist, with Cognito holding identity and Postgres holding profile and role assignment.
- **SC-05** — Partially: supplies the authorization predicate WS-09 enforces on routes.
- **SC-06** — The package compiles independently.

## Dependencies

- **WS-03** — Database (the `customers` table this package reads).

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — the "Auth" convention; note that a Cognito group is never the authoritative role
- `docs/vision.md` — sections "Target Users" and "Architecture" (the Cognito/Postgres split)
- `packages/contracts/src/roles.ts` — `ROLES`, `Role`, and `hasAtLeastRole`
- `packages/database/src/schema/people.ts` — the `customers` table, especially `cognito_sub`
- `packages/database/src/client.ts` — the exported `db` instance

## Package

`packages/auth` — published internally as `@keki/auth`.

## Files Touched

- `packages/auth/package.json` (NEW)
- `packages/auth/tsconfig.json` (NEW)
- `packages/auth/src/index.ts` (NEW) — barrel
- `packages/auth/src/env.ts` (NEW) — Cognito configuration
- `packages/auth/src/verify-token.ts` (NEW) — JWT verification against the JWKS
- `packages/auth/src/session.ts` (NEW) — session types and `resolveSession`
- `packages/auth/src/profile.ts` (NEW) — Cognito subject → customer profile lookup
- `packages/auth/src/authorize.ts` (NEW) — the single authorization predicate
- `packages/auth/src/errors.ts` (NEW) — typed auth failures
- `packages/auth/src/verify-token.test.ts` (NEW)
- `packages/auth/src/authorize.test.ts` (NEW)
- `packages/auth/src/profile.test.ts` (NEW)

## Existing Interfaces to Consume

From `@keki/contracts` (WS-02) — the role hierarchy predicate. This package must
**call** it, not reimplement it:

```ts
export const ROLES = ['CUSTOMER', 'FRONT_OF_HOUSE', 'MANAGER', 'ADMIN'] as const;
export type Role = (typeof ROLES)[number];

/** ADMIN > MANAGER > FRONT_OF_HOUSE > CUSTOMER; reflexive. */
export declare function hasAtLeastRole(actual: Role, required: Role): boolean;

export type CustomerId = Brand<string, 'CustomerId'>;
export type HouseholdId = Brand<string, 'HouseholdId'>;
```

From `@keki/database` (WS-03) — the customers table and the pooled client:

```ts
export const customers = pgTable('customers', {
  id: uuid('id').primaryKey().defaultRandom(),
  householdId: uuid('household_id').references(() => households.id),
  cognitoSub: text('cognito_sub').notNull().unique(),
  email: text('email').notNull().unique(),
  firstName: text('first_name'),
  lastName: text('last_name'),
  role: roleEnum('role').notNull().default('CUSTOMER'),
  status: text('status').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export declare const db: NeonHttpDatabase<typeof schema>;
```

## Implementation Steps

1. **Scaffold the package.** Dependencies: `@keki/contracts`, `@keki/database`,
   `aws-jwt-verify`, `zod`. Dev dependencies: `vitest`, `typescript`.

   Use `aws-jwt-verify` rather than hand-rolling JWKS fetching and signature
   checking. Hand-rolled JWT verification is a well-known source of
   authentication bypasses, and this is not the place to be inventive.

2. **Resolve Cognito configuration** in `src/env.ts` with a Zod schema:
   `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, and `AWS_REGION`, all required.
   Fail loudly at module load if any is missing, naming the variable. WS-10
   supplies these via SST resource linking.

   Additionally accept two **optional** overrides, `COGNITO_ISSUER` and
   `COGNITO_JWKS_URI`, defaulting to the values derived from the pool ID and
   region. WS-12's Playwright fixtures need to point verification at a locally
   served JWKS with a test key pair; without an override there is no way to
   authenticate an end-to-end test short of minting real Cognito sessions, which
   is slow, flaky, and couples CI to an AWS account.

   Guard the overrides: if either is set while `NODE_ENV === 'production'`,
   throw `AuthConfigError`. An issuer override in production is an
   authentication bypass — anyone who can set the variable can mint tokens.

3. **Build token verification** in `src/verify-token.ts`. Create the verifier
   once at module scope — `aws-jwt-verify` caches the JWKS, and constructing it
   per request defeats that cache and adds a network round trip to every
   authenticated call.

   ```ts
   export interface VerifiedToken {
     readonly sub: string;
     readonly email: string | undefined;
     readonly tokenUse: 'id' | 'access';
     readonly expiresAt: Date;
   }

   export declare function verifyToken(jwt: string): Promise<VerifiedToken>;
   ```

   Verify `tokenUse`, issuer, audience, and expiry. Throw a typed
   `InvalidTokenError` on any failure — never return `null` for a malformed
   token and a session for a valid one, because callers reliably forget to
   check.

   **Do not read any Cognito group claim.** Per `AGENTS.md`, groups are not the
   authoritative role. The role comes from Postgres in step 5.

4. **Define the session type** in `src/session.ts`:

   ```ts
   export interface CustomerProfile {
     readonly customerId: CustomerId;
     readonly householdId: HouseholdId | null;
     readonly email: string;
     readonly firstName: string | null;
     readonly lastName: string | null;
     readonly role: Role;
   }

   export interface Session {
     readonly cognitoSub: string;
     readonly profile: CustomerProfile;
   }
   ```

   A `Session` exists only when both halves resolve: a valid token **and** a
   matching Postgres profile. A verified token with no profile row is not a
   session — model that as a distinct outcome, not as a session with a null
   profile. Return a discriminated result:

   ```ts
   export type SessionResult =
     | { readonly kind: 'authenticated'; readonly session: Session }
     | { readonly kind: 'anonymous' }
     | { readonly kind: 'unprovisioned'; readonly cognitoSub: string };
   ```

   `unprovisioned` is the real state where Cognito knows the user but Postgres
   has no profile — first login, or a failed provisioning step. WS-09 must
   handle it explicitly rather than treating it as anonymous.

   **This package owns session resolution**, so that it is testable here without
   depending on WS-09:

   ```ts
   /** Verifies a token and loads its profile. Pure of any framework. */
   export declare function resolveSession(jwt: string | null): Promise<SessionResult>;
   ```

   `resolveSession` takes the token as an argument and knows nothing about
   cookies, `next/headers`, or request caching. WS-09's `getSessionResult()` is
   a thin Next-specific wrapper that reads the cookie and wraps this in
   `cache()`. Splitting it this way is what lets tests 1–7 below run against
   real logic rather than restating WS-09's future implementation.

5. **Implement the profile lookup** in `src/profile.ts`:

   ```ts
   export declare function findProfileByCognitoSub(
     cognitoSub: string,
   ): Promise<CustomerProfile | null>;
   ```

   Query `customers` by the unique `cognito_sub` index, selecting only the
   columns `CustomerProfile` needs. Map the row to the branded types from
   contracts. All access goes through the exported `db` from `@keki/database` —
   no direct driver use, per `AGENTS.md`.

6. **Implement the single authorization predicate** in `src/authorize.ts`. This
   is the one function WS-09 calls; everything else in this package is
   supporting machinery.

   ```ts
   export interface AuthorizeInput {
     readonly result: SessionResult;
     readonly requiredRole: Role;
   }

   export type AuthorizationOutcome =
     | { readonly allowed: true; readonly session: Session }
     | {
         readonly allowed: false;
         readonly reason: 'anonymous' | 'unprovisioned' | 'insufficient_role';
       };

   export declare function authorize(input: AuthorizeInput): AuthorizationOutcome;
   ```

   Implement it purely — no I/O — by delegating the ordering comparison to
   `hasAtLeastRole` from contracts. Do not write role comparisons here; there
   must be exactly one place in the repository that knows `MANAGER` outranks
   `FRONT_OF_HOUSE`.

   Returning a `reason` rather than a bare boolean lets WS-09 distinguish
   "redirect to sign-in" from "show 403" from "finish account setup", which are
   three genuinely different user experiences.

7. **Define typed errors** in `src/errors.ts`: `InvalidTokenError`,
   `ProfileNotFoundError`, `AuthConfigError`. Each extends `Error` with a
   discriminant field so callers can branch without string matching.

8. **Write the barrel** re-exporting the session types, `verifyToken`,
   `resolveSession`, `findProfileByCognitoSub`, `authorize`, and the errors. Do
   not export the raw verifier instance.

9. **Verify.** Run all four package scripts.

## Tests

Token tests use locally generated RSA keys and a stubbed JWKS endpoint — no
network, no real Cognito pool. Profile tests stub the `db` module.

1. **Valid token verifies** — Sign a token with the test key carrying the
   expected issuer, audience, and a future expiry; assert `verifyToken` resolves
   with the matching `sub`.
2. **Expired token is rejected** — Sign a token with a past expiry; assert
   `verifyToken` rejects with `InvalidTokenError`.
3. **Wrong audience is rejected** — Sign with a `client_id` other than
   `COGNITO_CLIENT_ID`; assert rejection.
4. **Wrong issuer is rejected** — Sign with a different user-pool issuer; assert
   rejection.
5. **Tampered signature is rejected** — Take a valid token, mutate one payload
   byte, re-encode; assert rejection. This is the test that would catch an
   accidental "decode without verify" regression.
6. **Cognito group claims are ignored** — Verify a token carrying
   `cognito:groups: ['ADMIN']` for a subject whose Postgres row has role
   `CUSTOMER`; assert the resolved session role is `CUSTOMER`. This directly
   guards the `AGENTS.md` rule that Cognito is not the role authority.
7. **Missing profile yields `unprovisioned`** — Call `resolveSession` with a
   validly signed token while `findProfileByCognitoSub` is stubbed to return
   `null`; assert the result kind is `unprovisioned` and carries the
   `cognitoSub`, and is _not_ `anonymous`.
   7a. **A null token yields `anonymous`** — Assert `resolveSession(null)` resolves
   to `anonymous` without attempting verification or a database query.
8. **`authorize` allows equal role** — For each role `r`, assert
   `authorize({ result: authenticated(r), requiredRole: r }).allowed === true`.
9. **`authorize` allows higher role** — Assert an `ADMIN` session passes a
   `FRONT_OF_HOUSE` requirement.
10. **`authorize` denies lower role with the right reason** — Assert a
    `CUSTOMER` session against a `MANAGER` requirement returns
    `{ allowed: false, reason: 'insufficient_role' }`.
11. **`authorize` distinguishes anonymous from unprovisioned** — Assert the two
    non-authenticated inputs produce distinct `reason` values, so WS-09 can
    route them differently.
12. **`authorize` performs no I/O** — Assert calling it with the database module
    stubbed to throw on any query still returns normally, proving the predicate
    is pure.
13. **Missing configuration fails at load** — With `COGNITO_USER_POOL_ID`
    unset, assert importing `env.ts` throws `AuthConfigError` naming the
    variable.
14. **Issuer/JWKS overrides apply outside production** — With
    `COGNITO_JWKS_URI` and `COGNITO_ISSUER` set and `NODE_ENV=test`, assert a
    token signed by the local test key verifies successfully.
15. **Issuer/JWKS overrides are refused in production** — With either override
    set and `NODE_ENV=production`, assert `env.ts` throws `AuthConfigError`.
    This is the guard that keeps the test affordance from becoming an
    authentication bypass.

## Acceptance Criteria

1. `packages/auth` compiles, lints, tests, and builds via all four scripts.
2. Exactly one exported function, `authorize`, makes an allow/deny decision, and
   it delegates role ordering to `hasAtLeastRole` from `@keki/contracts`.
3. No file in the package compares role strings directly or reads a
   `cognito:groups` claim.
4. `verifyToken` validates signature, issuer, audience, token use, and expiry
   via `aws-jwt-verify`, and throws `InvalidTokenError` on every failure path.
5. The JWKS verifier is constructed once at module scope, not per call.
6. `SessionResult` distinguishes `authenticated`, `anonymous`, and
   `unprovisioned` as three separate cases.
7. `AuthorizationOutcome` carries a `reason` on denial, with the three values
   listed in step 6.
8. All database access goes through the `db` export from `@keki/database`; the
   package imports no database driver directly.
9. `src/env.ts` throws a typed error naming any missing Cognito variable, and
   accepts optional `COGNITO_ISSUER` / `COGNITO_JWKS_URI` overrides that are
   rejected when `NODE_ENV === 'production'`.
10. All fifteen test cases pass, including case 6 (Cognito groups ignored),
    case 12 (predicate purity), and case 15 (overrides refused in production).
11. The package protects no routes and contains no Next.js import — route
    enforcement belongs to WS-09.
