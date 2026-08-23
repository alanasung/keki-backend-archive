# WS-04: `/auth/sign-in`, `/auth/callback`, and `/auth/sign-out`

## Goal

Replace the sign-in placeholder with the real redirect handshake, and add the
callback and sign-out routes it needs.

This is the workstream the program exists for. `/auth/sign-in` has said *"the
hosted sign-in flow arrives in Phase 2"* through three shipped programs; after
this, a person who has never been in the database can obtain a session.

It is also the riskiest workstream here, and for an unusual reason: a redirect
handshake is almost entirely failure modes, and every one of them surfaces as
"sign-in is broken" with no stack trace. A callback URL that does not match
what Cognito was configured with. A `state` nobody validated. A verifier cookie
that did not survive the round trip. Each is a one-line mistake and a total
outage.

## Traceability

- **SC-01** — `/auth/sign-in` redirects to the hosted UI with a correctly-formed
  authorization URL.
- **SC-02** — The verifier and `state` are stored in httpOnly cookies that
  survive the round trip.
- **SC-03** — `/auth/callback` exchanges the code and sets the id-token cookie
  under its existing name and shape.
- **SC-04** — A callback whose `state` does not match is refused before any
  token exchange.
- **SC-05** — The user is returned to the `next` path they were denied.
- **SC-06** — Partially: stores the refresh token and refreshes a near-expired
  session.
- **SC-07** — `/auth/sign-out` clears the cookies and redirects through
  Cognito's logout endpoint.
- **SC-17** — Partially: keeps the id-token cookie contract unchanged.

## Dependencies

- **WS-03** — `@keki/auth`'s handshake operations.

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Auth"; every `staff/` and `admin/` route requires an explicit
  role check, and Cognito owns identity while Postgres owns role
- `docs/vision.md` — "Target Users"
- `apps/web/app/auth/sign-in/page.tsx` — the placeholder being replaced, and
  the `next` handling it already does
- `apps/web/app/auth/guards.ts` — `requireRole`, `sanitizeNextPath`, and the
  three denial destinations
- `apps/web/app/auth/require-session.ts` — `getSessionResult`
- `apps/web/app/auth/demo-sign-in/sign-in-action.ts` — **how the id-token
  cookie is set today**; the callback must match it exactly
- `apps/web/middleware.ts` — the redirect to `/auth/sign-in?next=…` and the
  matcher that excludes `auth/`
- `packages/auth/src/cookies.ts` — `ID_TOKEN_COOKIE_NAME` and `extractToken`
- `packages/auth/src/oauth.ts` — WS-03's operations
- `apps/web/e2e/fixtures/session.ts` — the fixtures that set the same cookie

## Package

`apps/web`

## Files Touched

- `apps/web/app/auth/sign-in/page.tsx` (MODIFY — replace the placeholder with a redirect)
- `apps/web/app/auth/callback/route.ts` (NEW — the OAuth callback handler)
- `apps/web/app/auth/sign-out/route.ts` (NEW — clears cookies, redirects to Cognito)
- `apps/web/app/auth/sign-out/complete/route.ts` (NEW — Cognito's post-logout landing)
- `apps/web/app/auth/session-cookies.ts` (NEW — the one place session cookies are written)
- `apps/web/app/auth/require-session.ts` (MODIFY — refresh a near-expired session)
- `apps/web/app/auth/callback/route.test.ts` (NEW)
- `apps/web/app/auth/session-cookies.test.ts` (NEW)

## Existing Interfaces to Consume

**How the id-token cookie is set today.** The callback must produce a cookie
the existing readers and the Playwright fixtures both still accept — same name,
same `httpOnly`, same `path`:

```ts
const store = await cookies();
store.set(ID_TOKEN_COOKIE_NAME, token, {
  httpOnly: true,
  sameSite: 'lax',
  secure: false, // localhost only; this route cannot run in production.
  path: '/',
  maxAge: 60 * 60 * 2,
});
```

The cookie name and reader, shared with the Edge middleware:

```ts
export const ID_TOKEN_COOKIE_NAME = 'keki_id_token';
export function extractToken(cookieHeader: string | null): string | null;
```

The guard that sends people here, and the open-redirect protection already in
place:

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

The placeholder being replaced, which already sanitizes `next`:

```tsx
export default async function SignInPage({ searchParams }: SignInPageProps) {
  const params = await searchParams;
  const next = sanitizeNextPath(params.next);
  ...
}
```

WS-03's operations:

```ts
export function buildAuthorizationUrl(): AuthorizationRequest;  // { url, state, verifier }
export async function exchangeCodeForTokens(input: { code: string; verifier: string }): Promise<CognitoTokenResponse>;
export async function refreshSession(input: { refreshToken: string }): Promise<CognitoTokenResponse>;
export function buildSignOutUrl(): string;
export function shouldRefresh(expiresAt: Date, now: Date, skewSeconds?: number): boolean;
```

## Implementation Steps

1. **Centralize cookie writing** in `session-cookies.ts`. Four cookies exist
   after this workstream, and scattering their attributes across three routes is
   how one of them ends up non-`httpOnly`:

   - `keki_id_token` — the session, **name and shape unchanged**
   - `keki_refresh_token` — httpOnly, longer-lived
   - `keki_oauth_state` — httpOnly, short-lived (10 minutes)
   - `keki_oauth_verifier` — httpOnly, short-lived (10 minutes)

   Every one is `httpOnly: true`, `path: '/'`, and `secure` when
   `NODE_ENV === 'production'`.

   **`sameSite: 'lax'` for all four, deliberately.** The callback is a
   top-level GET navigation initiated by Cognito — a cross-site context.
   `Strict` would withhold the state and verifier cookies on exactly that
   request, and sign-in would fail every time with nothing in the logs. `Lax`
   permits top-level GETs, which is what this is.

2. **Rewrite `/auth/sign-in`** as a Server Component that redirects. Call
   `buildAuthorizationUrl()`, set the `state` and `verifier` cookies, and
   redirect to the URL.

   Carry `next` through the handshake by storing it in a short-lived cookie
   alongside the state, **not** by putting it in the OAuth `state` parameter.
   Cognito echoes `state` back verbatim; packing a path into it means a
   user-controlled value making a round trip through a third party, and the
   temptation to skip re-sanitizing it on return.

   Sanitize `next` with the existing `sanitizeNextPath` before storing —
   the same open-redirect guard the placeholder already applies.

   **Keep the demo sign-in route working.** It is how every demo of this
   product has been given and it is double-gated. Do not remove or redirect it.

3. **Write `/auth/callback`** as a Route Handler (`route.ts`), not a page — it
   consumes a redirect and issues another. In order:

   a. Read `code` and `state` from the query string.

   b. Read the `state` cookie. **If it is missing, or does not match, abort
      before any token exchange** and redirect to `/auth/sign-in`. This is the
      CSRF boundary; an unvalidated callback lets an attacker complete a
      sign-in against a victim's browser. Compare with a constant-time
      comparison.

   c. Read the verifier cookie; a missing one is the same failure.

   d. Exchange the code. On `OAuthExchangeError`, redirect to `/auth/sign-in`
      with a generic message — an authorization code is single-use, so the
      commonest cause is a refresh or a back-button replay, not an attack.

   e. Set the id-token and refresh-token cookies. Clear the state, verifier,
      and `next` cookies — they are spent, and a stale verifier is a replay
      surface.

   f. Redirect to the stored `next`, re-sanitized, defaulting to `/book`.

   **Handle Cognito's own error redirect.** If the query carries `error`
   instead of `code` (a user who cancelled, or a misconfigured client), redirect
   to sign-in rather than crashing on a missing parameter.

4. **Write `/auth/sign-out`** as a Route Handler: clear all four cookies, then
   redirect to `buildSignOutUrl()`. Clearing the local cookie alone leaves the
   Cognito session alive, so the next sign-in silently reuses it and the user
   appears never to have signed out.

5. **Write `/auth/sign-out/complete`** — where Cognito returns after logout.
   Clear the cookies again (defensively; the user may have arrived directly)
   and redirect to `/`.

6. **Add refresh to `require-session.ts`.** Before resolving, if the id token is
   near expiry per `shouldRefresh` and a refresh token exists, exchange it and
   set the new id-token cookie.

   **A failed refresh signs the user out** rather than retrying — a refresh
   token is rejected because the session is over, and retrying converts one
   failure into a loop.

   > A Server Component cannot set a cookie during render. Perform the refresh
   > where a response is being produced — the middleware or a route handler —
   > and have `getSessionResult` read the refreshed value. If the constraint
   > forces the refresh into middleware, put it there and say so in a comment;
   > do not silently skip refresh because the render path cannot write.

7. **Do not change `ID_TOKEN_COOKIE_NAME`, its `httpOnly` flag, or its path.**
   Every existing Playwright spec signs in by setting that exact cookie
   (`e2e/fixtures/session.ts`). Changing the contract breaks the whole suite,
   and the breakage would look like an auth bug rather than a renamed cookie.

8. **Run all four scripts.**

## Tests

Vitest with `@keki/auth`'s OAuth operations mocked at the module boundary. The
handshake cannot be driven against a live Cognito — CI has no user pool — so
the exchange is stubbed and the *routing and cookie decisions* are what get
asserted. That is a real limit, and these tests are written to cover everything
inside it.

1. **`/auth/sign-in` redirects to the authorization URL** — Assert a redirect
   whose location is the URL `buildAuthorizationUrl` returned. **This is SC-01.**
2. **It sets the state and verifier cookies** — Assert both are present,
   `httpOnly`, and carry the returned values. **This is SC-02.**
3. **Those cookies are `SameSite=Lax`, not `Strict`** — Assert the attribute.
   `Strict` withholds them on Cognito's top-level callback and breaks every
   sign-in; this is the test that pins the reasoning.
4. **They are `Secure` in production** — Set `NODE_ENV=production`; assert the
   flag. Assert it is absent otherwise, so localhost works.
5. **`next` is sanitized before being stored** — Pass
   `next=https://evil.example/x`; assert the stored value is a local path, not
   the absolute URL.
6. **A missing `next` defaults to a local path** — Assert no crash and a
   sensible default.
7. **The callback rejects a mismatched `state`** — Cookie says `A`, query says
   `B`; assert a redirect to sign-in and that **`exchangeCodeForTokens` was
   never called**. **This is SC-04**, and asserting the exchange did not happen
   is what distinguishes a real check from one that runs after the fact.
8. **The callback rejects a missing `state` cookie** — Assert the same.
9. **The callback rejects a missing verifier cookie** — Assert the same.
10. **A matching state proceeds to exchange** — Assert
    `exchangeCodeForTokens` was called with the query's `code` and the cookie's
    verifier.
11. **The callback sets the id-token cookie under its existing name** — Assert
    the cookie is exactly `keki_id_token`. **SC-03, SC-17** — a rename breaks
    every e2e fixture.
12. **The id-token cookie is httpOnly with path `/`** — Assert both, matching
    what the demo route sets.
13. **The refresh token is stored in its own httpOnly cookie** — Assert
    presence and the flag. **SC-06.**
14. **The state, verifier, and next cookies are cleared after exchange** —
    Assert all three are expired. A retained verifier is a replay surface.
15. **The callback redirects to the stored `next`** — Store `/account`; assert
    the redirect location. **This is SC-05.**
16. **The stored `next` is re-sanitized on return** — Store an absolute URL
    directly in the cookie; assert the redirect goes to a local path. Trusting
    a cookie you set earlier is still trusting input.
17. **A failed exchange redirects to sign-in without setting a session** —
    Throw `OAuthExchangeError`; assert the redirect and that no id-token cookie
    was set.
18. **A Cognito `error` parameter redirects to sign-in** — Query carries
    `error=access_denied` and no `code`; assert a redirect rather than a crash.
19. **`/auth/sign-out` clears all four cookies** — Assert each is expired.
20. **`/auth/sign-out` redirects to Cognito's logout URL** — Assert the
    location is `buildSignOutUrl()`'s value. **This is SC-07**; clearing only
    the local cookie leaves the Cognito session alive.
21. **`/auth/sign-out/complete` clears cookies and lands on `/`** — Assert
    both, since a user can arrive here directly.
22. **A near-expired session is refreshed** — Drive a request whose id token
    expires within the skew window; assert `refreshSession` was called and the
    new id token was written. **This is SC-06.**
23. **A session far from expiry is not refreshed** — Assert `refreshSession`
    was **not** called. The discriminating half of test 22.
24. **A failed refresh clears the session** — Throw `OAuthRefreshError`; assert
    the cookies are cleared rather than the request retrying.
25. **The demo sign-in route still sets the same cookie** — Assert it is
    untouched and functional under its flag, since every demo depends on it.
26. **The e2e session fixture's cookie is still accepted** — Build a cookie
    exactly as `e2e/fixtures/session.ts` does; assert `extractToken` reads it
    and `getSessionResult` resolves it. **SC-17.**

## Acceptance Criteria

1. `apps/web` passes all four scripts.
2. `/auth/sign-in` redirects to a correctly-formed authorization URL and stores
   the verifier and state in httpOnly cookies (tests 1–2). **SC-01, SC-02.**
3. Those cookies are `SameSite=Lax` and `Secure` in production (tests 3–4).
4. `next` is sanitized both when stored and when used (tests 5, 16). **SC-05.**
5. A mismatched or missing `state` aborts **before** any token exchange
   (tests 7–9). **SC-04.**
6. The id-token cookie keeps its existing name, `httpOnly` flag, and path, and
   the existing e2e fixture cookie still resolves (tests 11–12, 26).
   **SC-03, SC-17.**
7. The refresh token is stored in its own httpOnly cookie (test 13). **SC-06.**
8. Spent handshake cookies are cleared after exchange (test 14).
9. A failed exchange and a Cognito error both redirect to sign-in without
   creating a session (tests 17–18).
10. `/auth/sign-out` clears every cookie and redirects through Cognito's logout
    endpoint (tests 19–20). **SC-07.**
11. A near-expired session refreshes, a fresh one does not, and a failed
    refresh signs the user out (tests 22–24). **SC-06.**
12. The demo sign-in route is unchanged and still works (test 25).
