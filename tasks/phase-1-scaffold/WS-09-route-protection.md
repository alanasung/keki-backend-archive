# WS-09: Route protection and role gating

## Goal

Close the routes WS-08 built open. Add Next middleware and per-surface
authorization so `staff/` and `admin/` require authentication and an adequate
role, `(customer)` requires a customer session, and `kiosk/` follows the
device-session model.

All allow/deny decisions delegate to the single `authorize` predicate from
`@keki/auth`. This workstream enforces; it does not define policy ordering.

## Traceability

- **SC-05** — `staff/` and `admin/` routes require authentication and reject an unauthorized role.
- **SC-12** — Cognito holds identity and Postgres holds profile and role assignment (proven end to end here).
- **SC-04** — Placeholder routes still load for permitted roles.

## Dependencies

- **WS-04** — Auth (the `authorize` predicate and session resolution).
- **WS-08** — App shell (the routes being protected).

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Auth" convention; note that all `staff/` and `admin/` routes require an explicit role check
- `docs/vision.md` — "Target Users" for the role-to-surface mapping, and assumption #3 on the kiosk model
- `packages/auth/src/authorize.ts` — the `authorize` predicate and `AuthorizationOutcome`
- `packages/auth/src/session.ts` — `SessionResult`, `Session`, `CustomerProfile`
- `packages/auth/src/verify-token.ts` — `verifyToken`
- `packages/contracts/src/roles.ts` — `Role` and `hasAtLeastRole`
- `apps/web/app/nav-config.ts` — the surfaces being gated
- `apps/web/app/(customer)/layout.tsx`, `apps/web/app/staff/layout.tsx`, `apps/web/app/admin/layout.tsx`, `apps/web/app/kiosk/layout.tsx`

## Package

`apps/web`, with a supporting addition to `packages/auth`.

## Files Touched

- `apps/web/package.json` (MODIFY) — add the `@keki/auth` workspace dependency
- `apps/web/next.config.ts` (MODIFY) — add `@keki/auth` to `transpilePackages`
- `apps/web/middleware.ts` (NEW) — pathname header, coarse gate
- `apps/web/app/auth/require-session.ts` (NEW) — server-side session resolution
- `apps/web/app/auth/guards.ts` (NEW) — per-surface guard helpers
- `apps/web/app/auth/unauthorized/page.tsx` (NEW) — 403 surface
- `apps/web/app/auth/sign-in/page.tsx` (NEW) — placeholder sign-in
- `apps/web/app/auth/complete-profile/page.tsx` (NEW) — `unprovisioned` landing
- `apps/web/app/(customer)/layout.tsx` (MODIFY) — apply customer guard
- `apps/web/app/kiosk/layout.tsx` (MODIFY) — apply kiosk guard
- `apps/web/app/staff/layout.tsx` (MODIFY) — apply `FRONT_OF_HOUSE` guard
- `apps/web/app/admin/layout.tsx` (MODIFY) — apply `MANAGER` guard
- `packages/auth/src/cookies.ts` (NEW) — cookie name constants and token extraction
- `packages/auth/src/index.ts` (MODIFY) — export the cookie helpers
- `apps/web/app/auth/guards.test.ts` (NEW)
- `apps/web/middleware.test.ts` (NEW)

## Existing Interfaces to Consume

From `@keki/auth` (WS-04). The three-way `SessionResult` matters here — an
`unprovisioned` user is not anonymous, and routing them to sign-in produces a
loop where a signed-in user is repeatedly asked to sign in:

```ts
export type SessionResult =
  | { readonly kind: 'authenticated'; readonly session: Session }
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'unprovisioned'; readonly cognitoSub: string };

export interface Session {
  readonly cognitoSub: string;
  readonly profile: CustomerProfile;
}

export interface CustomerProfile {
  readonly customerId: CustomerId;
  readonly householdId: HouseholdId | null;
  readonly email: string;
  readonly role: Role;
  // ...
}

export type AuthorizationOutcome =
  | { readonly allowed: true; readonly session: Session }
  | {
      readonly allowed: false;
      readonly reason: 'anonymous' | 'unprovisioned' | 'insufficient_role';
    };

export declare function authorize(input: {
  result: SessionResult;
  requiredRole: Role;
}): AuthorizationOutcome;

export declare function verifyToken(jwt: string): Promise<VerifiedToken>;
export declare function findProfileByCognitoSub(
  cognitoSub: string,
): Promise<CustomerProfile | null>;
```

From `@keki/contracts` (WS-02):

```ts
export const ROLES = ['CUSTOMER', 'FRONT_OF_HOUSE', 'MANAGER', 'ADMIN'] as const;
export type Role = (typeof ROLES)[number];
```

## Implementation Steps

1. **Declare the new app dependency first.** WS-08 created
   `apps/web/package.json` with `@keki/ui` and `@keki/contracts`. This
   workstream additionally imports `@keki/auth`, so add it as a workspace
   dependency **and** to `transpilePackages` in `next.config.ts` — it ships
   TypeScript source under the WS-01 source-export convention, so Next will not
   compile it otherwise. Run `pnpm install` before writing code that imports it.

2. **Add cookie helpers to `@keki/auth`** (`src/cookies.ts`): export the cookie
   name constant (`keki_id_token`) and a pure
   `extractToken(cookieHeader: string | null): string | null`. Keeping the name
   in one place stops the middleware and the server guards from disagreeing
   about where the token lives.

3. **Write the middleware** (`apps/web/middleware.ts`) with two
   responsibilities and no more:

   a. **Set the `x-pathname` request header** on every request. WS-08's layouts
   read it to compute the nav's active item and currently fall back to
   `undefined`; this makes that work.

   b. **Apply a coarse unauthenticated gate** — if the path is under `/staff`
   or `/admin` and no session cookie is present at all, redirect to
   `/auth/sign-in?next=<path>`.

   **The middleware must not be the authorization boundary.** It runs on the
   Edge runtime, where `@keki/database` cannot open a Neon connection, so it
   cannot read the Postgres role — and a gate that cannot see the role cannot
   enforce one. Treat middleware as a fast path that avoids rendering for
   obviously-anonymous requests; the real check happens in step 5. Write this
   reasoning as a comment in the file, because the next person will otherwise
   "helpfully" move authorization into it.

   Set the matcher to exclude `/_next`, static assets, and `/auth/*` so the
   sign-in page itself is reachable.

4. **Implement server-side session resolution** in
   `app/auth/require-session.ts`:

   ```ts
   /** Resolves the current request's session. Cached per request. */
   export declare function getSessionResult(): Promise<SessionResult>;
   ```

   Keep this a **thin wrapper**. Read the cookie via `next/headers` and delegate
   to `resolveSession(token)` from `@keki/auth`, which WS-04 owns and tests. Do
   not re-implement verification or the profile lookup here — WS-04 already maps
   the three outcomes onto `SessionResult`, and a second implementation would
   drift from the one that is tested.

   The only logic that belongs here is the framework binding: reading the
   cookie, and wrapping the call in React's `cache()` so four nested layouts on
   one request produce one JWKS check and one database query rather than four.

   A token that fails verification must resolve to `anonymous`, never throw a
   500 — an expired cookie is an ordinary condition, not a server error.
   `resolveSession` already guarantees this; do not add a second try/catch that
   could swallow a genuine configuration error.

5. **Implement the guards** in `app/auth/guards.ts`. This is the real
   authorization boundary:

   ```ts
   /** Enforces `requiredRole` or redirects. Returns the session when allowed. */
   export declare function requireRole(requiredRole: Role): Promise<Session>;
   ```

   Call `getSessionResult()`, pass it to `authorize` with `requiredRole`, and
   branch on the outcome:

   - `allowed: true` → return the session.
   - `reason: 'anonymous'` → `redirect('/auth/sign-in?next=<path>')`.
   - `reason: 'unprovisioned'` → `redirect('/auth/complete-profile')`.
   - `reason: 'insufficient_role'` → `redirect('/auth/unauthorized')`.

   Three distinct destinations for three distinct reasons — this is exactly why
   WS-04 returns a `reason` instead of a boolean. Do not collapse them.

   Do not compare roles here. `authorize` already delegates ordering to
   `hasAtLeastRole`; a second comparison in this file is a second source of
   truth that will drift.

6. **Apply guards to the layouts:**
   - `app/staff/layout.tsx` → `await requireRole('FRONT_OF_HOUSE')`
   - `app/admin/layout.tsx` → `await requireRole('MANAGER')`
   - `app/(customer)/layout.tsx` → `await requireRole('CUSTOMER')`

   Because `hasAtLeastRole` is a hierarchy, an `ADMIN` passes the staff gate and
   a `MANAGER` passes the customer gate. That is intended.

   Guarding at the layout covers every page in the group, including pages added
   later — which is why the guard belongs in the layout rather than repeated in
   each page.

7. **Handle the kiosk surface.** `docs/vision.md` records the kiosk session
   model as an unresolved assumption (#3): shared on-site hardware with a
   non-account-first flow. Implement the minimum defensible behavior for
   Phase 1 and mark it clearly:

   - `kiosk/` requires a **device session**, not a user session: a
     `keki_kiosk_device` cookie whose value matches the
     `KIOSK_DEVICE_TOKEN` environment variable.
   - Absent or mismatched → redirect to `/auth/sign-in`.
   - The kiosk surface never resolves a `CustomerProfile` and never calls
     `requireRole`.

   Add a `TODO(phase-2)` noting that a shared static token is adequate for a
   scaffold but is not a real device-identity mechanism, and that the model
   needs a decision before the kiosk handles waivers or payments. Do not build a
   device-enrollment flow in this workstream.

8. **Build the three auth pages** — `sign-in`, `unauthorized`,
   `complete-profile` — as placeholders using `PageShell` and
   `PlaceholderPanel`, consistent with WS-08. `sign-in` must not implement a
   credential form: Cognito owns authentication, and a hand-rolled login form in
   the app is exactly the split this architecture avoids. State that the hosted
   Cognito flow arrives in Phase 2 and preserve the `next` query parameter.

9. **Guard the redirect target.** When building the `next` parameter, accept
   only same-origin relative paths beginning with a single `/`. Reject
   protocol-relative (`//evil.example`) and absolute URLs. An unvalidated
   `next` is an open-redirect, and sign-in pages are where they get exploited.

10. **Verify.** Run all four scripts for `apps/web` and `@keki/auth`, then
    manually confirm the redirect behavior for each role.

## Tests

Guard tests stub `getSessionResult` and assert on the redirect target. WS-12
adds the Playwright end-to-end coverage.

1. **Anonymous is redirected to sign-in from staff** — Stub `anonymous`; assert
   `requireRole('FRONT_OF_HOUSE')` redirects to `/auth/sign-in` with a `next`
   parameter carrying the original path.
2. **Anonymous is redirected from admin** — Same for `requireRole('MANAGER')`.
3. **Unprovisioned goes to complete-profile, not sign-in** — Stub
   `unprovisioned`; assert the redirect is `/auth/complete-profile`. Asserting
   it is _not_ `/auth/sign-in` is the point: that confusion causes a redirect
   loop for a signed-in user.
4. **Insufficient role goes to unauthorized** — Stub an authenticated
   `CUSTOMER`; assert `requireRole('MANAGER')` redirects to
   `/auth/unauthorized`, not to sign-in.
5. **Sufficient role is allowed** — Stub `MANAGER`; assert
   `requireRole('MANAGER')` returns the session without redirecting.
6. **Higher role passes a lower gate** — Stub `ADMIN`; assert
   `requireRole('FRONT_OF_HOUSE')` and `requireRole('CUSTOMER')` both succeed.
7. **Lower role fails a higher gate** — Stub `FRONT_OF_HOUSE`; assert
   `requireRole('ADMIN')` redirects to unauthorized.
8. **Guards do not compare roles themselves** — Assert `guards.ts` contains no
   direct role string comparison and no reimplementation of the hierarchy.
9. **Expired token resolves to anonymous, not an error** — Stub `verifyToken`
   to reject with `InvalidTokenError`; assert `getSessionResult()` resolves to
   `anonymous` and does not throw.
10. **Session resolution is cached per request** — Call `getSessionResult()`
    three times in one request scope with a spy on `findProfileByCognitoSub`;
    assert exactly one database call.
11. **Middleware sets `x-pathname`** — Invoke the middleware with a request for
    `/staff/today`; assert the forwarded request headers contain
    `x-pathname: /staff/today`.
12. **Middleware redirects cookieless staff requests** — Assert a `/staff/today`
    request with no cookie receives a redirect to `/auth/sign-in`.
13. **Middleware does not gate public paths** — Assert `/book` and
    `/auth/sign-in` pass through without redirect, so the sign-in page is
    reachable and the customer surface is not blocked at the edge.
14. **Middleware performs no database access** — Assert `middleware.ts` imports
    neither `@keki/database` nor any `*-core` package, guarding the Edge-runtime
    constraint in step 2.
15. **Kiosk requires a matching device token** — Assert a request with no
    `keki_kiosk_device` cookie redirects; one with a wrong value redirects; one
    matching `KIOSK_DEVICE_TOKEN` renders.
16. **Kiosk never resolves a user profile** — Assert the kiosk layout does not
    call `requireRole` or `findProfileByCognitoSub`.
17. **Open-redirect is rejected** — Assert `next` values `//evil.example`,
    `https://evil.example`, and `/\evil.example` are all rejected and fall back
    to a safe default path; assert `/staff/today` is accepted.

## Acceptance Criteria

1. `apps/web` and `packages/auth` compile, lint, test, and build.
2. Unauthenticated requests to any `/staff/*` or `/admin/*` route redirect to
   `/auth/sign-in`; authenticated requests with an insufficient role redirect to
   `/auth/unauthorized`.
3. `requireRole` is the only authorization entry point used by layouts, and it
   delegates every decision to `authorize` from `@keki/auth`.
4. No file in `apps/web` compares role strings or reimplements the role
   hierarchy.
5. The three denial reasons route to three distinct destinations: sign-in,
   complete-profile, and unauthorized.
6. `getSessionResult` is wrapped in `cache()` and performs at most one profile
   lookup per request (test 10).
7. An invalid or expired token yields `anonymous` rather than an unhandled
   error.
8. `middleware.ts` imports no database or core package and sets `x-pathname` on
   every matched request.
9. The middleware matcher excludes `/_next`, static assets, and `/auth/*`.
10. The kiosk surface is gated by a device cookie only, never resolves a
    `CustomerProfile`, and carries a `TODO(phase-2)` recording that the device
    model is unresolved.
11. The `next` redirect parameter accepts only same-origin relative paths
    (test 17).
12. `/auth/sign-in` contains no credential form; authentication remains
    Cognito's responsibility.
13. All eleven WS-08 routes still load for a user with an adequate role.
