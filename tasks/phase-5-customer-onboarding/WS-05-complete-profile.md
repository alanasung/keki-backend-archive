# WS-05: `/auth/complete-profile` — first-time profile provisioning

## Goal

Replace the `/auth/complete-profile` placeholder with the form a brand-new
customer lands on: collect a name, create their customer row and household, and
return them to whatever they were trying to reach.

`guards.ts` has redirected here since Phase 1 whenever a verified token has no
matching `customers` row. Until now that redirect led to a `PlaceholderPanel`,
so the only way out of the unprovisioned state was a seed script. This is the
step that makes a real Cognito account into a Keki customer.

## Traceability

- **SC-08** — A signed-in user with no `customers` row is sent here.
- **SC-09** — Completing the profile creates the customer and household, and
  returns the user to where they were going.
- **SC-10** — Profile completion is idempotent: submitting twice does not
  create a second household.

## Dependencies

- **WS-01** — Contracts (`completeProfileSchema`).
- **WS-04** — The auth routes, since this page is only reachable with a real
  session.

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Auth"; Cognito owns identity, Postgres owns profile and role
- `docs/vision.md` — "Target Users"; the Customer persona
- `apps/web/app/auth/complete-profile/page.tsx` — the placeholder being replaced
- `apps/web/app/auth/guards.ts` — the `unprovisioned` redirect that leads here
- `apps/web/app/auth/require-session.ts` — `getSessionResult` and the
  `unprovisioned` result shape
- `apps/web/app/actions/authenticated-action.ts` — the action wrapper, and why
  it authorizes before parsing
- `apps/web/app/actions/action-result.ts` — the `ActionResult` envelope
- `packages/customer-core/src/commands.ts` — `provisionCustomerProfile`, which
  is already real and already idempotent
- `packages/auth/src/session.ts` — `SessionResult` and its three cases
- `packages/ui/src/components/form-field.tsx` — Phase 3's field component

## Package

`apps/web`

## Files Touched

- `apps/web/app/auth/complete-profile/page.tsx` (MODIFY — replace the placeholder)
- `apps/web/app/auth/complete-profile/profile-form.tsx` (NEW — client island)
- `apps/web/app/auth/complete-profile/complete-profile-action.ts` (NEW)
- `apps/web/app/auth/complete-profile/page.test.tsx` (NEW)
- `apps/web/app/auth/complete-profile/complete-profile-action.test.ts` (NEW)
- `packages/auth/src/verify-token.ts` (MODIFY — carry the name claims)
- `packages/auth/src/session.ts` (MODIFY — carry email and names on the unprovisioned case)
- `packages/auth/src/verify-token.test.ts` (MODIFY)
- `packages/auth/src/session.test.ts` (MODIFY)

## Existing Interfaces to Consume

The placeholder being replaced, in full:

```tsx
import { PageShell, PlaceholderPanel } from '@keki/ui';

export default function CompleteProfilePage() {
  return (
    <PageShell
      title="Complete your profile"
      description="You're signed in, but no customer profile exists for this account yet."
    >
      <PlaceholderPanel title="Profile setup" plannedFor="Phase 2" />
    </PageShell>
  );
}
```

The guard that routes here — note it is the **unprovisioned** case
specifically, distinct from anonymous and from an insufficient role:

```ts
if (outcome.reason === 'anonymous') {
  const next = sanitizeNextPath(await currentPath());
  redirect(`/auth/sign-in?next=${encodeURIComponent(next)}`);
}
if (outcome.reason === 'unprovisioned') {
  redirect('/auth/complete-profile');
}
redirect('/auth/unauthorized');
```

`provisionCustomerProfile` — **already real and already idempotent**, which is
what makes SC-10 achievable without new locking:

```ts
export async function provisionCustomerProfile(input: {
  cognitoSub: string;
  email: string;
  firstName?: string;
  lastName?: string;
}): Promise<Customer> {
  const existing = await findCustomerByCognitoSub(input.cognitoSub);
  if (existing !== null) {
    return existing;
  }

  const householdId = randomUUID();
  const customerId = randomUUID();
  const firstName = input.firstName ?? '';
  const lastName = input.lastName ?? '';
  const householdName = [firstName, lastName].filter((part) => part.length > 0).join(' ') || input.email;

  const [, insertedCustomers] = await db.batch([
    db.insert(households).values({ id: householdId, name: `${householdName} Household` }),
    ...
```

WS-01's schema, which deliberately omits `email` and `cognitoSub`:

```ts
export const completeProfileSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
}).strict();
```

## Implementation Steps
1. **Build the page** in `page.tsx` as a Server Component. Resolve the session
   result directly — **do not call `requireRole`**, which would redirect an
   unprovisioned user back to this same page and loop forever. This is the one
   route in the app that must handle the `unprovisioned` case rather than
   delegating it.

   Three cases, three outcomes:

   - **anonymous** → redirect to `/auth/sign-in`; there is nothing to complete
   - **unprovisioned** → render the form (the reason this page exists)
   - **authenticated** → redirect away to `/book`; a provisioned customer
     landing here has nothing to do, and showing them a form that would no-op is
     worse than moving them along

2. **Extend `@keki/auth` to carry the claims this page needs — this is in
   scope.** `VerifiedToken` currently exposes only `sub`, `email`, `tokenUse`,
   and `expiresAt`, and `SessionResult`'s `unprovisioned` case carries only
   `cognitoSub`. Neither the email nor the name claims reach this page, so
   steps 3 and 4 below are impossible without it.

   Add `givenName` and `familyName` to `VerifiedToken`, reading `given_name`
   and `family_name` and treating a non-string as `undefined` exactly as
   `email` is already handled. Then widen the `unprovisioned` result to carry
   `email`, `givenName`, and `familyName` alongside `cognitoSub`.

   Additive only — no existing field changes type or disappears, so nothing
   that reads a `VerifiedToken` today breaks. Do **not** instead re-extract the
   cookie and call `verifyToken` directly from the page or the action:
   `require-session.ts` centralizes that specifically to avoid a second JWKS
   fetch per request, and duplicating it would put an authentication decision
   in two places.

3. **Build the form** in `profile-form.tsx` as a `'use client'` island: first
   name, last name, submit. Use `FormField` from `packages/ui`, disable the
   control while pending via `useTransition`, and render
   `result.error.message` on failure.

4. **Pre-fill from the verified token.** Cognito's `given_name` and
   `family_name` claims are present when the user supplied them at sign-up.
   Pre-filling is a courtesy; the fields stay editable, because the hosted UI's
   sign-up form is not necessarily where someone wants their name to come from.

   Show the email address as **read-only text, not a field**. It comes from the
   verified token, WS-01 makes it unrepresentable as an input, and rendering it
   as an input invites the expectation that editing it does something.

5. **Write the action** in `complete-profile-action.ts`.

   **Do not wrap it in `authenticatedAction`.** That wrapper's default
   `requiredRole` is `CUSTOMER`, and `authorize` denies an unprovisioned
   session — so every call would return `UNPROVISIONED` and the profile could
   never be created. This is the one mutation in the app whose entire purpose is
   to run *before* a profile exists.

   Instead: resolve the session result, accept **only** the `unprovisioned`
   case, and reject anonymous. Parse with `completeProfileSchema`. Then call
   `provisionCustomerProfile` with `cognitoSub` and `email` taken from the
   **verified token**, never from the payload.

   Return the same `ActionResult` envelope every other action returns, so the
   form handles failures identically.

6. **Rely on `provisionCustomerProfile`'s idempotence for SC-10.** It returns
   the existing customer when one is found for the `cognitoSub`, so a double
   submit yields one household. Do not add a second guard on top; two
   mechanisms for one invariant drift.

   > A genuine concurrent double-submit is a race this program does not close —
   > `findCustomerByCognitoSub` then insert is check-then-act. `customers.cognito_sub`
   > is `unique`, so the second insert fails at the database rather than
   > creating a duplicate. Surface that as a retry rather than an error page.

7. **Return the user to where they were going.** WS-04 stores the sanitized
   `next` during the handshake; read it, re-sanitize, and redirect there,
   defaulting to `/book`. **SC-09.**

8. **Do not create children or collect a household name here.** Onboarding
   should ask for the minimum that makes an account usable. Adding a child is
   WS-07's job, on a page the customer can return to.

9. **Run all four scripts.**

## Tests

Vitest with `@keki/customer-core` and `@keki/auth` mocked at the module
boundary.

1. **An unprovisioned session renders the form** — Assert both name fields are
   present. **This is SC-08.**
2. **An anonymous session redirects to sign-in** — Assert the redirect; there
   is no profile to complete.
3. **An authenticated session redirects away** — Assert a redirect to `/book`,
   not a rendered form. A provisioned customer here has nothing to do.
4. **The page does not call `requireRole`** — Assert the module does not import
   it. `requireRole` redirects unprovisioned users *here*, so using it would
   loop.
5. **The email renders as read-only text, not an input** — Assert the address
   appears and that no editable control holds it.
6. **Names pre-fill from the token claims** — Mock `given_name: 'Ada'`; assert
   the field's default value is `Ada`.
7. **Missing claims leave the fields empty, not undefined** — Assert empty
   strings, so React does not warn about an uncontrolled-to-controlled switch.
8. **Submitting calls the action with the parsed names** — Assert exact values.
9. **The action creates the profile with the token's cognitoSub and email** —
   Assert `provisionCustomerProfile` received the **session's** values.
10. **A payload-supplied email is ignored** — Send `email: 'attacker@example.com'`;
    assert the command received the token's address. `customers.email` is unique
    and is how staff find people; a forged one is an account takeover vector.
11. **A payload-supplied cognitoSub is ignored** — Assert the same for identity
    itself.
12. **An anonymous caller is rejected by the action** — Assert `ok: false` and
    that `provisionCustomerProfile` was never called.
13. **An already-provisioned caller does not create a second household** — Mock
    an existing customer; assert `provisionCustomerProfile` returns it and no
    second household id appears. **This is SC-10.**
14. **A duplicate `cognito_sub` insert surfaces as a retry, not a crash** —
    Throw a unique-violation; assert the envelope is a `CONFLICT` with an
    actionable message rather than `INTERNAL`.
15. **Blank names are refused** — Submit `'  '`; assert `VALIDATION` and no
    command call.
16. **A successful completion redirects to the stored `next`** — Store
    `/account`; assert the redirect. **This is SC-09.**
17. **The stored `next` is re-sanitized** — Store an absolute URL; assert the
    redirect goes to a local path.
18. **A missing `next` defaults to `/book`** — Assert the default rather than a
    crash.
19. **The submit control disables while pending** — Assert it is disabled
    during the transition, so a double-click cannot double-submit.
20. **A failed action renders its message** — Mock `ok: false`; assert the
    message appears rather than a silent failure.

## Acceptance Criteria

1. `apps/web` passes all four scripts.
2. An unprovisioned session renders the form; anonymous and authenticated
   sessions redirect elsewhere (tests 1–3). **SC-08.**
3. The page does not use `requireRole`, so it cannot loop against its own guard
   (test 4).
4. Email is displayed, never editable, and a payload-supplied email or
   `cognitoSub` is ignored in favor of the verified token (tests 5, 10–11).
5. Names pre-fill from token claims and degrade to empty strings (tests 6–7).
6. Completing the profile creates the customer and household from session
   values (test 9). **SC-09.**
7. A second submission does not create a second household, and a concurrent
   duplicate surfaces as an actionable conflict (tests 13–14). **SC-10.**
8. The user is returned to their sanitized stored `next`, defaulting to `/book`
   (tests 16–18). **SC-09.**
9. Blank names are refused before any command runs (test 15).
10. No child creation or household naming is added here.
