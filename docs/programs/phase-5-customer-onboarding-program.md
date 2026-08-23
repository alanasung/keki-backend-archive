# keki-backend-prod — Program Plan (Phase 5 Customer Onboarding)

## Program Overview

**Product:** Keki is the commerce and operations platform for a cafe that runs
classes, rents rooms, and hosts open play. One Next.js 15 application on AWS
serves four surfaces — customer, kiosk, staff, admin — over a set of plain
TypeScript domain packages, with Square for payments, a waiver provider for
liability signing, and Klaviyo/SES/SMS for customer communication.

**Program scope:** Let a real person use Keki.

Three programs have built a working commerce and operations system on top of
an assumption nobody has questioned: that the person using it already exists in
the database. They do not. `/auth/sign-in` is still a placeholder reading *"the
hosted sign-in flow arrives in Phase 2"* — Phases 2, 3, and 4 have all shipped
past it. The only working sign-in is a flag-gated demo route that hands out
pre-minted tokens.

And even with an account, the core journey is broken a second time:
**`addChild` is a stub.** The product sells classes for children, and a parent
has no way to tell the system their child exists. Children come from a seed
script. Booking a kid into a class requires a developer.

This program closes both. After it, someone who has never been in the database
can create an account, add their family, and buy a seat.

## Strategic Goals

1. **Make the front door real.** Replace the sign-in placeholder with the
   Cognito hosted-UI handshake the infrastructure was provisioned for in Phase 1
   and has never used.
2. **Let a household describe itself.** A parent adds their own children and
   names their household, rather than a seed script doing it for them.
3. **Keep a session alive through a checkout.** A token that expires mid-purchase
   with no refresh path is worse than a short session; it is a lost order.
4. **Give staff a way to find a customer.** `/admin/customers` is the surface
   staff reach for when someone phones, and it is the last admin placeholder.
5. **Unblock a pilot.** Every remaining deferral — waivers, passes, refunds —
   is a feature. This one is a precondition.

## Architecture Changes

Changes from the system described in `docs/as-built.md` (current as of
`phase-4-staff-surfaces`).

**The Cognito client gains an OAuth configuration.** `infra/auth.ts` creates a
user pool, a client, and a hosted-UI domain, with a comment conceding the
domain is unused. The client today has no callback URLs, no allowed flows, and
no scopes — it cannot participate in a redirect handshake. This adds
authorization-code flow with PKCE, callback and logout URLs per stage, and the
`openid email profile` scopes.

**PKCE, and a public client with no secret.** The browser initiates the
redirect, so a client secret would have to live somewhere it could leak. PKCE
is what makes a public client safe, and Cognito supports it directly.

**`@keki/auth` gains the handshake, and only the handshake.** It already owns
`verifyToken`, `resolveSession`, and `authorize`. This adds the authorization
URL builder, the code-for-token exchange, refresh, and the sign-out URL. It
stays a library: no Next.js imports, no route handlers, so the kiosk surface
can reuse it later.

**A `/auth/callback` route handler.** Not a page — it consumes a redirect,
sets a cookie, and redirects onward. It must validate the `state` parameter
against a cookie set at sign-in, or the callback is a CSRF hole.

**Sessions refresh instead of expiring.** Cognito id tokens last an hour by
default. Without a refresh path a customer is bounced to sign-in mid-checkout,
having lost a cart. The refresh token is stored in its own httpOnly cookie and
exchanged when the id token is near expiry.

**`customer-core` gets its first write paths since Phase 1.** `addChild` and
`updateHousehold` stop rejecting with `NotImplementedInPhase1`. `/account`
stops being read-only — a decision its own doc comment attributes directly to
those stubs.

**The demo sign-in route stays.** It is how every demo has been given, it is
gated on both `NODE_ENV !== 'production'` and an explicit flag, and the e2e
suite's own session fixtures do not go through Cognito either. Replacing it
with the real flow would make local development depend on a deployed user pool.

## Technology Choices

No new technology — uses the existing stack. Six decisions this program settles
that the brief left open:

| Decision | Choice | Rationale |
| --- | --- | --- |
| OAuth flow | Authorization code with PKCE, public client, no secret | The browser starts the redirect, so a secret would have to live somewhere it could leak. PKCE is the standard answer and Cognito supports it natively. |
| Session lifetime | Refresh token in its own httpOnly cookie, exchanged near id-token expiry | A one-hour hard session drops customers mid-checkout. Building refresh later means redoing the cookie contract. |
| Social login | Out of scope | Each provider is its own configuration, consent screen, and account-linking problem. Email and password gets a pilot running. |
| Profile completion | A dedicated `/auth/complete-profile` step, not silent provisioning on callback | `provisionCustomerProfile` needs a name. Guessing one from an email address produces households called "jsmith Household". The guard already redirects here. |
| Child date of birth | Required | `children.date_of_birth` is `notNull`, and age is what decides which class a child belongs in. Collecting it later means a nullable column and a backfill. |
| `/admin/customers` | Read-only lookup | Staff editing a household from the admin side is a second, larger set of questions. Finding someone is the need that exists today. |

## Workstreams

| ID | Workstream | Dependencies | Estimated Effort |
| --- | --- | --- | --- |
| WS-01 | Contracts: profile, child, and household input schemas; OAuth state types | — | S |
| WS-02 | Infrastructure: Cognito OAuth client configuration and hosted-UI outputs | — | S |
| WS-03 | `@keki/auth`: authorization URL, code exchange, refresh, sign-out | WS-01, WS-02 | M |
| WS-04 | `/auth/sign-in`, `/auth/callback`, `/auth/sign-out` | WS-03 | M |
| WS-05 | `/auth/complete-profile` | WS-01, WS-04 | S |
| WS-06 | `customer-core`: real `addChild` and `updateHousehold` | WS-01 | S |
| WS-07 | `/account`: add a child, rename the household | WS-06 | M |
| WS-08 | `/admin/customers`: staff customer lookup | WS-01 | M |
| WS-09 | Tests, e2e coverage, and documentation | WS-04, WS-05, WS-07, WS-08 | M |

**Size key:** S = 1–2 days, M = 3–5 days, L = 5–10 days

### Workstream detail

- **WS-01** — Zod schemas for profile completion (first and last name),
  `addChild` (names plus date of birth), and household rename. Plus the types
  the OAuth handshake passes around: authorization request, token response,
  and the `state`/`code_verifier` pair.
- **WS-02** — Configures the existing client for authorization-code flow with
  PKCE, per-stage callback and logout URLs, and `openid email profile`. Exports
  the hosted-UI domain so the app can build an authorization URL.
- **WS-03** — `buildAuthorizationUrl`, `exchangeCodeForTokens`,
  `refreshSession`, and `buildSignOutUrl`, plus PKCE challenge generation. No
  Next.js imports; this stays a library.
- **WS-04** — The three routes. `/auth/sign-in` generates a verifier and state,
  sets them as short-lived cookies, and redirects to Cognito.
  `/auth/callback` validates state, exchanges the code, sets the session
  cookies, and returns the user to their `next` path. `/auth/sign-out` clears
  cookies and redirects through Cognito's logout endpoint.
- **WS-05** — The form a signed-in-but-unprovisioned user lands on. Collects a
  name, calls `provisionCustomerProfile`, and returns them to where they were
  going.
- **WS-06** — `addChild` and `updateHousehold` become real, each scoped to the
  caller's own household.
- **WS-07** — `/account` gains an add-child form and a household rename,
  replacing the read-only panels its doc comment says exist only because those
  commands were stubs.
- **WS-08** — `/admin/customers`: search by email or name, then a household
  view with members, children, and recent orders.
- **WS-09** — A Playwright journey covering complete-profile → add a child →
  book that child, plus documentation.

## Dependency Graph

```
   WS-01 (contracts)          WS-02 (infra)
     |    |      \             /
     |    |       \           /
     |    |      WS-03 (auth handshake)
     |    |            |
     |    |       WS-04 (sign-in / callback / sign-out)
     |    |            |
     |    +-------- WS-05 (complete-profile)
     |
  WS-06 (customer-core writes)      WS-08 (admin/customers)
     |                                    |
  WS-07 (/account)                        |
     \             |                     /
      +------------+--------------------+
                   |
            WS-09 (tests + docs)

WS-03 depends on WS-01 and WS-02 — it needs the token types and a client that
  can actually participate in the flow.
WS-05 depends on WS-04: it is only reachable once a real session exists.
WS-08 depends on WS-01 only — a read-only surface over data that already
  exists, so it carries slack.
```

Parallelism: WS-01 and WS-02 are independent and start together. WS-06 → WS-07
runs alongside the entire auth chain, and WS-08 alongside everything.

## Critical Path

```
WS-01 → WS-03 → WS-04 → WS-05 → WS-09
```

Roughly 19 working days serialized. The path runs through the handshake because
nothing else in the program is reachable without a real session — WS-05 exists
precisely to catch a user who has just completed one.

The place to be careful is WS-04. A redirect handshake is mostly failure modes:
a callback URL that does not match what Cognito was configured with, a `state`
that is not validated, a verifier cookie that does not survive the round trip,
an expired code, a user who lands on the callback twice. Each fails in a way
that looks like "sign-in is broken" and none produce a useful stack trace.

WS-02 is small but sits under the path's first link, and it is the one
workstream whose correctness cannot be fully proven locally: the callback URL
must match a deployed environment.

## Scope (In)

- Cognito hosted-UI authorization-code flow with PKCE
- `/auth/sign-in`, `/auth/callback`, `/auth/sign-out`
- Session refresh before id-token expiry
- `/auth/complete-profile` and first-time profile provisioning
- Real `addChild` and `updateHousehold`
- `/account`: add a child, rename the household
- `/admin/customers`: read-only staff lookup
- Playwright coverage of the onboarding journey; documentation

## Scope (Out)

Explicitly deferred — do not implement in this program:

- Social login, and any external identity provider
- MFA, and customizing Cognito's password-reset or email-verification screens
- Editing or deleting a child once added
- Staff editing a household from `/admin/customers`
- Merging or transferring households
- Removing the demo sign-in route
- Waivers, play passes, refunds — still stubs, still out
- `/kiosk/book` and `/kiosk/waiver`, which stay placeholders
- Account deletion, data export, and any other privacy-request tooling
- Email change, which is an identity change and belongs with account recovery

## Risk Register

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Callback URL mismatch between Cognito and the app | **Critical** — sign-in fails entirely, with an error page from Cognito rather than the app, so it looks like an outage | WS-02 derives callback URLs from the same stage configuration the app uses, and `infra/index.ts` already asserts a configured URL matches a deployed one for the Square webhook — WS-02 follows that precedent. |
| `state` not validated on callback | **Critical** — a CSRF hole that lets an attacker complete a sign-in against a victim's session | `state` is generated at sign-in, stored in a short-lived httpOnly cookie, and compared on callback; a mismatch aborts before any token exchange. A WS-04 test asserts the mismatch path. |
| The PKCE verifier cookie does not survive the round trip | High — every sign-in fails, and the cause is invisible in application logs | The cookie is set `SameSite=Lax` deliberately: the callback is a top-level GET navigation from Cognito, which `Lax` permits and `Strict` would drop. A WS-04 test asserts the attribute. |
| Sessions expire mid-checkout | High — a customer loses a cart an hour into a visit | Refresh tokens are stored and exchanged before expiry (WS-03). A WS-09 test drives a request with a near-expired id token and asserts the session survives. |
| The real flow cannot be exercised end to end in tests | Medium — the riskiest code in the program is the least testable | Accepted and bounded: e2e asserts `/auth/sign-in` redirects to a correctly-formed authorization URL, and the callback is tested against a **stubbed token endpoint** rather than a live Cognito. Driving the hosted UI in Playwright is explicitly out of scope; CI has no user pool. |
| The e2e session fixtures stop working | High — every existing Playwright spec signs in by minting its own token against a local JWKS server | Those fixtures set the same cookie this program's callback sets. The cookie contract must not change name or shape; a WS-04 acceptance criterion pins it, and WS-09 asserts the existing specs still pass untouched. |
| Demo sign-in breaks or is removed | Medium — every demo of this product has gone through it | Explicitly out of scope to remove. WS-09 asserts the route still works under its flag. |
| A child added with a future date of birth | Low — nonsense data, and age-based class rules later read it | Refused at the schema (WS-01), with a test for the boundary. |
| `addChild` writing to another household | **Critical** — one customer adds a child to a stranger's family | The command takes the household from the session, never the payload — the rule Phase 3 and 4 established for `actorCustomerId`. A WS-06 test sends a foreign household id and asserts it is ignored. |

## Success Criteria

| ID | Outcome |
| --- | --- |
| SC-01 | `/auth/sign-in` redirects to the Cognito hosted UI with a correctly-formed authorization URL carrying `client_id`, `redirect_uri`, `code_challenge`, and `state`. |
| SC-02 | The PKCE verifier and `state` are stored in httpOnly cookies that survive the redirect round trip. |
| SC-03 | `/auth/callback` exchanges an authorization code for tokens and sets the id-token cookie under its existing name and shape. |
| SC-04 | A callback whose `state` does not match the cookie is refused before any token exchange. |
| SC-05 | After callback, the user is returned to the `next` path they were originally denied. |
| SC-06 | A session whose id token is near expiry is refreshed without the user signing in again. |
| SC-07 | `/auth/sign-out` clears the session cookies and redirects through Cognito's logout endpoint. |
| SC-08 | A signed-in user with no `customers` row is sent to `/auth/complete-profile`. |
| SC-09 | Completing the profile creates the customer and household, and returns the user to where they were going. |
| SC-10 | Profile completion is idempotent: submitting twice does not create a second household. |
| SC-11 | A customer can add a child with a first name, last name, and date of birth. |
| SC-12 | A child is always added to the caller's own household, never one supplied in the payload. |
| SC-13 | A future date of birth is refused. |
| SC-14 | A customer can rename their household. |
| SC-15 | A newly added child appears as a bookable participant on the class booking flow. |
| SC-16 | `/admin/customers` finds a household by customer email or name and shows its members, children, and recent orders. |
| SC-17 | The existing Playwright session fixtures still work unchanged — the cookie contract did not move. |
| SC-18 | Playwright covers the journey: complete a profile, add a child, and book that child into a class. |
