# WS-03: `@keki/auth` — authorization URL, code exchange, refresh, sign-out

## Goal

Give `@keki/auth` the four operations a redirect handshake needs:
build an authorization URL with a PKCE challenge, exchange the returned code
for tokens, refresh an expiring session, and build a sign-out URL.

The package already owns everything about *reading* a session — `verifyToken`,
`resolveSession`, `authorize`. It owns nothing about *obtaining* one. That gap
is why `/auth/sign-in` has been a placeholder through three programs.

This stays a library: **no Next.js imports, no route handlers, no cookies.**
WS-04 wires these into routes. Keeping the seam means the kiosk surface can
reuse the same handshake later without inheriting a page.

## Traceability

- **SC-01** — Builds an authorization URL carrying `client_id`, `redirect_uri`,
  `code_challenge`, and `state`.
- **SC-03** — Partially: exchanges an authorization code for tokens. WS-04 sets
  the cookie.
- **SC-06** — Partially: refreshes a session from a refresh token.
- **SC-07** — Partially: builds the Cognito logout URL.

## Dependencies

- **WS-01** — Contracts (`AuthorizationRequest`, `cognitoTokenResponseSchema`,
  `PkcePair`).
- **WS-02** — Infrastructure (the hosted-UI URL, redirect URI, and a client
  configured to accept them).

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Auth"; Cognito owns authentication and identity, Postgres owns
  profile and role, and a Cognito group is never the authoritative role
- `docs/vision.md` — "Target Users"; the role ladder
- `packages/auth/src/env.ts` — `resolveCognitoEnv` and the production guard on
  issuer overrides, which this extends rather than replaces
- `packages/auth/src/verify-token.ts` — `verifyToken` and `VerifiedToken`
- `packages/auth/src/session.ts` — `resolveSession`, `Session`, `SessionResult`
- `packages/auth/src/errors.ts` — the typed-error style
- `packages/auth/src/index.ts` — the barrel
- `packages/contracts/src/oauth.ts` — WS-01's token response schema
- `packages/auth/src/test-support` — the existing test helpers, including how
  a local JWKS server is used to sign tokens

## Package

`packages/auth`

## Files Touched

- `packages/auth/src/oauth.ts` (NEW — the four operations plus PKCE)
- `packages/auth/src/oauth-env.ts` (NEW — hosted-UI, redirect, and sign-out config)
- `packages/auth/src/errors.ts` (MODIFY — handshake errors)
- `packages/auth/src/index.ts` (MODIFY — barrel)
- `packages/auth/src/oauth.test.ts` (NEW)
- `packages/auth/src/oauth-env.test.ts` (NEW)

## Existing Interfaces to Consume

The environment resolver this sits beside. Note the production guard — the new
config must not weaken it:

```ts
export interface CognitoEnv {
  readonly userPoolId: string;
  readonly clientId: string;
  readonly region: string;
  readonly issuer: string;
  readonly jwksUri: string;
}

if ((issuerOverride !== undefined || jwksUriOverride !== undefined) && nodeEnv === 'production') {
  // An issuer override in production is an authentication bypass: anyone
  // who can set the variable can mint tokens accepted as genuine.
  throw new AuthConfigError(
    'COGNITO_ISSUER and COGNITO_JWKS_URI overrides are not permitted when NODE_ENV=production.',
  );
}
```

The session resolver the exchanged token feeds:

```ts
export interface Session {
  readonly cognitoSub: string;
  readonly profile: CustomerProfile;
}

export type SessionResult = /* anonymous | unprovisioned | authenticated */;

export async function resolveSession(jwt: string | null): Promise<SessionResult>;
```

WS-01's token response schema — `passthrough`, and `refresh_token` optional
because Cognito omits it on a refresh exchange:

```ts
export const cognitoTokenResponseSchema = z.object({
  id_token: z.string().min(1),
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive(),
  token_type: z.string(),
}).passthrough();
```

WS-01's handshake types:

```ts
export interface AuthorizationRequest {
  readonly url: string;
  readonly state: string;
  readonly verifier: string;
}
```

## Implementation Steps

1. **Resolve the new configuration** in `oauth-env.ts`, mirroring `env.ts`'s
   shape and its fail-loudly-naming-the-variable behavior:

   ```ts
   export interface CognitoOAuthEnv {
     readonly hostedUiUrl: string;
     readonly redirectUri: string;
     readonly signOutUri: string;
   }
   ```

   Read `COGNITO_HOSTED_UI_URL`, `COGNITO_REDIRECT_URI`, and
   `COGNITO_SIGN_OUT_URI` — the variables WS-02 supplies.

   **Require `https` for every URL when `NODE_ENV === 'production'`**, allowing
   `http://localhost` otherwise. An `http` redirect URI in production puts an
   authorization code on the wire in clear text.

2. **Add typed errors** to `errors.ts`: `OAuthStateMismatchError`,
   `OAuthExchangeError` (carrying the HTTP status), and
   `OAuthRefreshError`. Keep them distinct — a state mismatch is a possible
   attack and an exchange failure is usually a misconfiguration, and a single
   error type would make the two indistinguishable in logs.

3. **Implement PKCE generation**:

   ```ts
   export function createPkcePair(): PkcePair;
   ```

   Verifier: 32 random bytes, base64url, no padding. Challenge:
   `base64url(sha256(verifier))`, again unpadded.

   Use `node:crypto`'s `randomBytes` and `createHash`. **Not `Math.random()`** —
   a predictable verifier defeats the entire mechanism, and this is the one
   place in the program where weak randomness is silently exploitable rather
   than merely wrong.

   Base64url means `+` → `-`, `/` → `_`, and `=` stripped. A standard-base64
   challenge is rejected by Cognito with an opaque error.

4. **Implement `buildAuthorizationUrl`**:

   ```ts
   export function buildAuthorizationUrl(input?: { now?: () => number }): AuthorizationRequest;
   ```

   Returns the URL plus the `state` and `verifier` the caller must store. Query
   parameters: `response_type=code`, `client_id`, `redirect_uri`, `scope`
   (`openid email profile`), `state`, `code_challenge`,
   `code_challenge_method=S256`.

   Generate `state` as 32 random bytes, base64url — the same requirement as the
   verifier, for the same reason.

   Build with `URL`/`URLSearchParams` rather than string concatenation, so
   every value is encoded once and correctly.

   **Do not accept a `redirect_uri` from the caller.** It comes from
   configuration. A caller-supplied redirect is an open redirect, and Cognito's
   exact-match registration is the only thing that would catch it.

5. **Implement `exchangeCodeForTokens`**:

   ```ts
   export async function exchangeCodeForTokens(input: {
     code: string;
     verifier: string;
     fetchImpl?: typeof fetch;
   }): Promise<CognitoTokenResponse>;
   ```

   POST to `${hostedUiUrl}/oauth2/token` with
   `Content-Type: application/x-www-form-urlencoded` and a body of
   `grant_type=authorization_code`, `client_id`, `code`, `redirect_uri`, and
   `code_verifier`.

   Parse the response with `cognitoTokenResponseSchema`. On a non-2xx, throw
   `OAuthExchangeError` with the status — and **do not include the response
   body in the message**, because a token endpoint's error body can echo the
   code back.

   `fetchImpl` is injected so tests can drive this against a stub. It is the
   only way this function is testable without a live Cognito, and CI has no
   user pool.

6. **Implement `refreshSession`**:

   ```ts
   export async function refreshSession(input: {
     refreshToken: string;
     fetchImpl?: typeof fetch;
   }): Promise<CognitoTokenResponse>;
   ```

   Same endpoint, `grant_type=refresh_token`, no `code_verifier`.

   **Cognito returns no `refresh_token` on this exchange.** The caller keeps
   the one it already has; WS-01's schema makes the field optional precisely so
   this does not fail parsing.

   Throw `OAuthRefreshError` on failure. A refresh failure means the session is
   over — the caller signs the user out rather than retrying.

7. **Implement `buildSignOutUrl`**:

   ```ts
   export function buildSignOutUrl(): string;
   ```

   `${hostedUiUrl}/logout?client_id=...&logout_uri=...`, where `logout_uri` is
   the configured sign-out URI. Clearing the local cookie alone leaves the
   Cognito session alive, so the next sign-in silently reuses it and the user
   appears never to have signed out.

8. **Add a helper for refresh timing**:

   ```ts
   export function shouldRefresh(expiresAt: Date, now: Date, skewSeconds?: number): boolean;
   ```

   True when `expiresAt` is within the skew window (default 120 seconds) of
   `now`. Refreshing exactly at expiry races the clock; a token that expires
   mid-request fails the request that triggered the refresh.

9. **Do not import Next.js, `next/headers`, or any cookie API.** This package is
   consumed by Lambda handlers as well as the app. Cookie handling belongs to
   WS-04.

10. **Export from the barrel** and run all four scripts, then `pnpm -r typecheck`.

## Tests

Pure functions and stubbed `fetch`; no live Cognito, which CI does not have.

1. **`createPkcePair` produces a base64url verifier** — Assert it contains no
   `+`, `/`, or `=`, and is at least 43 characters (the RFC 7636 minimum).
2. **The challenge is the SHA-256 of the verifier, base64url** — Compute it
   independently in the test and assert equality. Asserting only that a
   challenge exists would pass for a challenge that is the verifier itself.
3. **Two calls produce different verifiers** — Assert inequality across 10
   pairs. A constant verifier defeats PKCE entirely and would pass tests 1–2.
4. **`buildAuthorizationUrl` sets `response_type=code`** — Assert the exact
   value, and that `implicit` appears nowhere.
5. **It sets `code_challenge_method=S256`** — Assert exactly `S256`; `plain`
   sends the verifier in the clear.
6. **It carries the configured `client_id` and `redirect_uri`** — Assert both
   equal the configured values exactly.
7. **The redirect URI cannot be supplied by the caller** — Assert the function
   takes no redirect parameter, so an open redirect is unrepresentable.
8. **It requests `openid email profile`** — Assert the scope parameter.
9. **The returned `state` and `verifier` match those embedded in the URL** —
   Assert the URL's `state` equals the returned `state` and its
   `code_challenge` derives from the returned `verifier`. A mismatch here makes
   every callback fail state validation.
10. **Two authorization URLs differ in `state`** — Assert inequality; a fixed
    `state` is a CSRF hole.
11. **Parameters are URL-encoded** — Configure a redirect URI containing a
    query string; assert it appears encoded, not raw.
12. **`exchangeCodeForTokens` posts form-encoded** — Assert the request's
    `Content-Type` is `application/x-www-form-urlencoded` and the body parses
    as such. A JSON body is rejected by Cognito.
13. **The body carries grant type, code, verifier, and redirect URI** — Assert
    each field's exact value.
14. **It returns the parsed token response** — Stub a valid response; assert
    `id_token` comes back verbatim.
15. **A non-2xx throws `OAuthExchangeError` with the status** — Stub a 400;
    assert the error type and that `status` is `400`.
16. **The error message does not contain the response body** — Stub a 400 whose
    body contains the authorization code; assert the message does **not**
    contain it.
17. **A malformed token response throws** — Stub a 200 whose body lacks
    `id_token`; assert it throws rather than returning a session with no token.
18. **`refreshSession` uses `grant_type=refresh_token`** — Assert the body, and
    that no `code_verifier` is sent.
19. **A refresh response without a `refresh_token` succeeds** — Stub one;
    assert it parses. **Cognito omits it here**, and requiring it would break
    every refresh.
20. **A failed refresh throws `OAuthRefreshError`** — Assert the type, so the
    caller can sign the user out rather than retrying.
21. **`buildSignOutUrl` carries the client id and logout URI** — Assert both
    parameters.
22. **`shouldRefresh` is true inside the skew window** — Expiry 60s away with a
    120s skew; assert `true`.
23. **`shouldRefresh` is false outside it** — Expiry 10 minutes away; assert
    `false`. The discriminating half of test 22.
24. **`shouldRefresh` is true for an already-expired token** — Expiry in the
    past; assert `true`.
25. **`oauth-env` rejects a non-https redirect URI in production** — Set
    `NODE_ENV=production` with an `http://` redirect; assert it throws.
26. **It permits `http://localhost` outside production** — Assert no throw, so
    local development works.
27. **It names the missing variable** — Omit `COGNITO_HOSTED_UI_URL`; assert
    the error message contains that name, matching `env.ts`'s behavior.
28. **The package imports nothing from Next.js** — Assert no source file under
    `packages/auth/src` imports `next` or `next/headers`.

## Acceptance Criteria

1. `packages/auth` passes all four scripts, and `pnpm -r typecheck` passes
   workspace-wide.
2. PKCE verifiers and `state` values are cryptographically random, base64url,
   and different on every call (tests 1–3, 10).
3. The challenge is provably the SHA-256 of the verifier (test 2).
4. The authorization URL uses the code flow with `S256`, carries the configured
   client id and redirect URI, and requests `openid email profile` (tests 4–8).
   **SC-01.**
5. The redirect URI is unrepresentable as a caller input (test 7).
6. The returned `state` and `verifier` match what the URL embeds (test 9).
7. `exchangeCodeForTokens` posts form-encoded with all four fields and returns
   the parsed response (tests 12–14). **SC-03.**
8. A failed exchange throws a typed error carrying the status and **never**
   echoes the response body (tests 15–16).
9. `refreshSession` succeeds when Cognito omits the refresh token, and throws a
   distinct typed error on failure (tests 18–20). **SC-06.**
10. `buildSignOutUrl` targets Cognito's logout endpoint (test 21). **SC-07.**
11. `shouldRefresh` triggers inside the skew window and for expired tokens, and
    not otherwise (tests 22–24).
12. Non-https URLs are refused in production (test 25).
13. The package imports no Next.js surface (test 28).
