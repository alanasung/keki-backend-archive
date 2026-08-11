# WS-07: Server Action foundation and authenticated mutation wrapper

## Goal

Introduce the first Server Actions in the codebase. `docs/as-built.md` records
that `'use server'` appears nowhere today and every page is a placeholder — this
workstream establishes the mutation pattern that WS-09 and every later surface
copy.

It ships no product behavior. It delivers one wrapper, one error envelope, and
the tests that prove an unauthenticated caller cannot reach a mutation.

The reason this is its own workstream rather than part of WS-09: authorization
is the thing you cannot retrofit. If the cart actions invent their own session
handling under delivery pressure, every later surface copies that instead.

## Traceability

- **SC-14** — Server Actions reject unauthenticated callers through the shared
  `authorize` predicate.

## Dependencies

- **WS-01** — Contracts (typed error envelope shapes).

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Auth"; Cognito owns identity, Postgres owns roles, and every
  gated route needs an explicit role check
- `docs/vision.md` — "API Surface"; Server Actions are the first-party mutation
  surface
- `docs/as-built.md` — "Known Limitations"; no Server Actions exist yet
- `packages/auth/src/index.ts` — the exported auth surface
- `apps/web/app/auth/guards.ts` — `requireRole`, the existing authorization
  boundary and the redirect semantics to match
- `apps/web/app/auth/require-session.ts` — `getSessionResult`
- `apps/web/middleware.ts` — the route-level gate this complements

## Package

`apps/web`

## Files Touched

- `apps/web/app/actions/action-result.ts` (NEW) — the result envelope
- `apps/web/app/actions/authenticated-action.ts` (NEW) — the wrapper
- `apps/web/app/actions/errors.ts` (NEW) — domain-error → envelope mapping
- `apps/web/app/actions/authenticated-action.test.ts` (NEW)
- `apps/web/app/actions/errors.test.ts` (NEW)

## Existing Interfaces to Consume

The auth surface. `authorize` is the single authorization predicate — this
wrapper delegates to it and never compares roles itself:

```ts
export type { AuthorizationOutcome, AuthorizeInput } from './authorize';
export { authorize } from './authorize';
export { ID_TOKEN_COOKIE_NAME, extractToken } from './cookies';
export { AuthConfigError, InvalidTokenError, ProfileNotFoundError } from './errors';
export { findProfileByCognitoSub } from './profile';
export type { CustomerProfile, Session, SessionResult } from './session';
export { resolveSession } from './session';
```

The existing guard, whose three-way denial semantics this wrapper must mirror
rather than reinvent. Note the comment: exactly one place decides role
hierarchy.

```ts
/**
 * Enforces `requiredRole` on the calling layout, the real authorization
 * boundary for `staff/`, `admin/`, and `(customer)/`. Every allow/deny
 * decision is delegated to `authorize` from `@keki/auth`, which in turn
 * delegates role ordering to `hasAtLeastRole` — this function never compares
 * roles itself, so there is exactly one place that hierarchy can drift.
 */
export async function requireRole(requiredRole: Role): Promise<Session> {
  const result = await getSessionResult();
  const outcome = authorize({ result, requiredRole });

  if (outcome.allowed) {
    return outcome.session;
  }

  if (outcome.reason === 'anonymous') {
    const next = sanitizeNextPath(await currentPath());
    redirect(`/auth/sign-in?next=${encodeURIComponent(next)}`);
  }
  if (outcome.reason === 'unprovisioned') {
    redirect('/auth/complete-profile');
  }
  redirect('/auth/unauthorized');
}
```

## Implementation Steps

1. **Define the result envelope** in `action-result.ts`:

   ```ts
   export type ActionResult<T> =
     | { readonly ok: true; readonly data: T }
     | { readonly ok: false; readonly error: ActionError };

   export interface ActionError {
     readonly code: ActionErrorCode;
     readonly message: string;
     readonly fieldErrors?: Readonly<Record<string, readonly string[]>>;
   }

   export const ACTION_ERROR_CODES = [
     'UNAUTHENTICATED',
     'UNPROVISIONED',
     'FORBIDDEN',
     'VALIDATION',
     'CONFLICT',
     'UNAVAILABLE',
     'INTERNAL',
   ] as const;
   export type ActionErrorCode = (typeof ACTION_ERROR_CODES)[number];
   ```

   Actions **return** failures rather than throwing. A thrown error in a Server
   Action reaches the client as an opaque digest with no message, which is
   correct for leak prevention but useless for showing a customer why their cart
   was rejected. The envelope carries a safe, deliberate message instead.

2. **Implement the wrapper** in `authenticated-action.ts`:

   ```ts
   'use server';

   export function authenticatedAction<TInput, TOutput>(config: {
     schema: z.ZodType<TInput>;
     requiredRole?: Role; // default 'CUSTOMER'
     handler: (input: TInput, session: Session) => Promise<TOutput>;
   }): (raw: unknown) => Promise<ActionResult<TOutput>>;
   ```

   Order of operations, which is not arbitrary:

   a. **Resolve the session and authorize first, before parsing input.** An
      unauthenticated caller must not be able to probe validation behavior to
      learn the shape of internal schemas.

   b. Call `authorize({ result, requiredRole })` from `@keki/auth`. Never
      compare roles here — the guard comment above states there is exactly one
      place hierarchy may live, and this is not it.

   c. Map the three denial reasons onto codes: `anonymous → UNAUTHENTICATED`,
      `unprovisioned → UNPROVISIONED`, otherwise `FORBIDDEN`. Keeping them
      distinct matches `requireRole`'s three destinations; collapsing them would
      make a provisioning gap look like a permissions failure.

   d. **Do not `redirect()` from the wrapper.** `requireRole` redirects because
      it runs during render. An action invoked by a fetch must return a result
      the caller can act on; a redirect thrown from an action is a confusing
      client-side navigation mid-mutation. Return `UNAUTHENTICATED` and let the
      caller decide.

   e. Parse the input with the supplied schema; on failure return `VALIDATION`
      with `fieldErrors` from the Zod error.

   f. Run the handler, mapping thrown domain errors through `errors.ts`.

3. **Map domain errors** in `errors.ts`. Translate the typed errors this program
   introduces into codes and customer-safe messages:

   - `CapacityExceededError` → `CONFLICT`, "That class just sold out."
   - `CatalogItemUnavailableError` / `CatalogItemNotFoundError` →
     `CONFLICT`, "An item in your cart is no longer available."
   - `OccurrenceNotBookableError` → `CONFLICT`
   - `InvalidOrderTransitionError` / `InvalidReservationTransitionError` →
     `CONFLICT`
   - `SquareApiError` → `UNAVAILABLE`, "Checkout is temporarily unavailable."
   - Anything else → `INTERNAL` with a **generic** message.

   **Never put an unrecognized error's message into the envelope.** An
   unmapped error can carry a connection string or a Square error body; the
   envelope crosses to the browser. Log the real error server-side with
   `console.error` and return the generic text.

4. **Add a `Cache-Control` consideration note.** Actions must not be cached;
   confirm no route-segment config in `apps/web` marks the actions module
   static.

5. **Do not create any product action here.** WS-09 writes the cart actions on
   top of this. A placeholder action would be dead code the moment WS-09 lands.

6. **Run all four scripts** for `apps/web`.

## Tests

Use Vitest with `@keki/auth` mocked at the module boundary, mirroring how
`apps/web/app/auth/guards.test.ts` already tests authorization.

1. **Anonymous caller is rejected** — `authorize` returns
   `{ allowed: false, reason: 'anonymous' }`; assert `ok: false` and code
   `UNAUTHENTICATED`. **This is SC-14.**
2. **Unprovisioned caller is distinguished** — Assert `UNPROVISIONED`, not
   `UNAUTHENTICATED`.
3. **Insufficient role is rejected** — Assert `FORBIDDEN`.
4. **Authorization runs before validation** — Call an anonymous request with a
   payload that would also fail schema parse; assert the code is
   `UNAUTHENTICATED`, not `VALIDATION`, proving ordering.
5. **The handler never runs when unauthorized** — Assert the handler spy was not
   called.
6. **The wrapper delegates to `authorize`** — Assert the `@keki/auth` mock was
   called with the required role, proving no local role comparison.
7. **Default required role is `CUSTOMER`** — Assert `authorize` received
   `'CUSTOMER'` when none was supplied.
8. **Valid input reaches the handler with the session** — Assert the handler
   received parsed input and the resolved session.
9. **Invalid input returns `VALIDATION` with field errors** — Assert
   `fieldErrors` names the offending field.
10. **The wrapper does not redirect** — Assert no `next/navigation` redirect was
    invoked, distinguishing this from `requireRole`.
11. **Mapped domain errors produce their codes** — Assert
    `CapacityExceededError → CONFLICT` and `SquareApiError → UNAVAILABLE`.
12. **Unmapped errors return a generic message** — Throw an error whose message
    contains `postgres://user:password@host`; assert the envelope's message does
    **not** contain it and the code is `INTERNAL`.
13. **Unmapped errors are logged server-side** — Assert `console.error` received
    the original error.
14. **A successful action returns `ok: true` with data** — Assert the envelope
    shape.

## Acceptance Criteria

1. `apps/web` passes all four scripts.
2. `authenticatedAction` resolves the session and authorizes **before** parsing
   input (test 4).
3. Every allow/deny decision delegates to `authorize` from `@keki/auth`; the
   wrapper contains no role comparison (test 6).
4. The three denial reasons map to three distinct codes.
5. The wrapper returns an `ActionResult` and never calls `redirect()`.
6. Validation failures return `VALIDATION` with per-field errors.
7. Unmapped errors return a generic message and never leak the original text
   (test 12), while logging the original server-side.
8. No product-specific Server Action is added in this workstream.
9. `'use server'` appears in the codebase for the first time, confined to the
   actions module.
