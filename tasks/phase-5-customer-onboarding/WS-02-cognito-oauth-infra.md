# WS-02: Infrastructure — Cognito OAuth client configuration and hosted-UI outputs

## Goal

Make the Cognito client capable of participating in a redirect handshake.

Phase 1 provisioned a user pool, a client, and a hosted-UI domain — and the
domain's own comment concedes nothing consumes it. The client has **no allowed
OAuth flows, no callback URLs, and no scopes**, so today a redirect to the
hosted UI would be rejected by Cognito before a user saw a form. This adds
authorization-code flow with PKCE, per-stage callback and logout URLs, and the
`openid email profile` scopes, then exposes the hosted-UI domain to the app.

No application code. WS-03 and WS-04 consume what this exports.

## Traceability

- **SC-01** — Partially: supplies the client id, hosted-UI domain, and
  registered redirect URI the authorization URL is built from.
- **SC-07** — Partially: registers the logout URL Cognito redirects back to.

## Dependencies

None. Independent of WS-01 and can run alongside it.

## Context Files (Agent MUST read before implementing)

- `AGENTS.md` — "Delivery"; SST + OpenNext own all AWS provisioning, and no
  resource is created by hand in the console
- `docs/vision.md` — "Target Users"; Cognito owns identity, Postgres owns role
- `infra/auth.ts` — the module being changed, in full
- `infra/index.ts` — where `createAuth` is called and how outputs are returned,
  including the `assertNotificationUrlConfigured` precedent for asserting a
  configured URL matches a deployed one
- `infra/web.ts` — how Cognito values reach the app's environment
- `infra/secrets.ts` — the secret declarations, and `AppBaseUrl`
- `packages/auth/src/env.ts` — the variables `@keki/auth` validates today
- `docs/environment.md` — the environment contract this extends

## Package

`infra`

## Files Touched

- `infra/auth.ts` (MODIFY — OAuth flows, callback and logout URLs, scopes, domain output)
- `infra/web.ts` (MODIFY — pass the hosted-UI domain and redirect URI to the app)
- `infra/index.ts` (MODIFY — thread the base URL into `createAuth`)
- `docs/environment.md` (MODIFY — document the new variables)

## Existing Interfaces to Consume

The module as it stands. Note the client is created with no options at all, and
the domain's comment states outright that nothing uses it:

```ts
export const USER_POOL_NAME = "KekiUserPool";
export const USER_POOL_CLIENT_NAME = "KekiWebClient";

export interface AuthResources {
  userPool: sst.aws.CognitoUserPool;
  client: sst.aws.CognitoUserPoolClient;
  domain: aws.cognito.UserPoolDomain;
}

export function createAuth(hostedUiDomainPrefix: string): AuthResources {
  const userPool = new sst.aws.CognitoUserPool(USER_POOL_NAME, {
    usernames: ["email"],
    transform: {
      userPool: (args) => {
        args.passwordPolicy = { ...PASSWORD_POLICY };
        return undefined;
      },
    },
  });

  const client = userPool.addClient(USER_POOL_CLIENT_NAME);

  // WS-09's sign-in placeholder will eventually redirect through this
  // hosted UI domain; nothing consumes it yet in Phase 1.
  const domain = new aws.cognito.UserPoolDomain(`${USER_POOL_NAME}Domain`, {
    domain: hostedUiDomainPrefix,
    userPoolId: userPool.id,
  });

  return { userPool, client, domain };
}
```

How it is called, and the account guard that runs first:

```ts
assertExpectedAccount();
const secrets = createSecrets();
const bucket = createDocumentsBucket();
const auth = createAuth(`keki-${$app.stage}`);
```

How Cognito values already reach the app:

```ts
environment: {
  COGNITO_USER_POOL_ID: auth.userPool.id,
  COGNITO_CLIENT_ID: auth.client.id,
  ...
}
```

The precedent for asserting a configured URL matches a deployed one — the same
class of failure this workstream risks:

```ts
assertNotificationUrlConfigured(secrets, workers.squareWebhookHttp.url);
```

## Implementation Steps

1. **Read the SST `CognitoUserPoolClient` API before writing anything.**
   `addClient` accepts a `transform.client` escape hatch onto the underlying
   `aws.cognito.UserPoolClient` args, which is where the OAuth fields live
   (`allowedOauthFlows`, `allowedOauthFlowsUserPoolClient`,
   `allowedOauthScopes`, `callbackUrls`, `logoutUrls`, `supportedIdentityProviders`).
   Use the transform rather than guessing at a first-class option that may not
   exist in the pinned SST version (3.19.3, see `AGENTS.md`).

2. **Take the app's base URL as a parameter.** `createAuth` currently takes only
   a domain prefix. Callback and logout URLs must be absolute and must match
   what the browser will actually send, so the base URL has to come from the
   same place the app gets it — the `AppBaseUrl` secret — rather than being
   reconstructed here.

   ```ts
   export function createAuth(input: {
     hostedUiDomainPrefix: string;
     appBaseUrl: $util.Input<string>;
   }): AuthResources;
   ```

3. **Configure the client** for authorization-code flow:

   - `allowedOauthFlowsUserPoolClient: true` — without this the other OAuth
     settings are inert, and it is the single easiest field to omit
   - `allowedOauthFlows: ["code"]` — **not** `implicit`, which returns tokens
     in the URL fragment where they land in browser history and referrer headers
   - `allowedOauthScopes: ["openid", "email", "profile"]` — `openid` yields the
     id token the session is built from; `email` and `profile` populate the
     claims `/auth/complete-profile` pre-fills from
   - `callbackUrls: [`${appBaseUrl}/auth/callback`]`
   - `logoutUrls: [`${appBaseUrl}/auth/sign-out/complete`]`
   - `supportedIdentityProviders: ["COGNITO"]` — social login is out of scope,
     and naming the provider explicitly stops a later addition being implicit

   **Generate no client secret.** The browser initiates this redirect, so a
   secret would have to be reachable from somewhere it could leak. PKCE is what
   makes a public client safe, and Cognito supports it without additional
   configuration on the client — the challenge travels in the authorization
   request. Do not set `generateSecret: true`.

4. **Include localhost callbacks outside production.** Local development runs
   at `http://localhost:3000`, and Cognito rejects any redirect URI not
   registered exactly. Add the localhost pair when `$app.stage !== 'production'`
   so a developer stage works without hand-editing the console — which
   `AGENTS.md` forbids anyway.

   Cognito permits `http` only for `localhost`; every other callback must be
   `https`. Assert that rather than discovering it at deploy time.

5. **Export the hosted-UI base URL** from `AuthResources`:

   ```ts
   hostedUiBaseUrl: $interpolate`https://${domain.domain}.auth.${aws.getRegionOutput().name}.amazoncognito.com`
   ```

   This is what WS-03 builds authorization and logout URLs against. Deriving it
   in the app from a domain prefix would duplicate a format AWS owns.

6. **Pass the new values to the app** in `infra/web.ts`, alongside the existing
   Cognito variables:

   - `COGNITO_HOSTED_UI_URL`
   - `COGNITO_REDIRECT_URI`
   - `COGNITO_SIGN_OUT_URI`

   Naming them explicitly, rather than having the app assemble the redirect URI
   from a base URL, means the value the app sends is the same string Cognito was
   configured with — which is the entire class of bug this workstream is most
   likely to ship.

7. **Assert the callback URL is registered.** Follow the
   `assertNotificationUrlConfigured` precedent: at deploy time, assert the
   `COGNITO_REDIRECT_URI` handed to the app appears in the client's
   `callbackUrls`. A mismatch produces an error page from Cognito, not from the
   app, so it looks like an outage and gives no stack trace.

8. **Document the three new variables** in `docs/environment.md`, in the same
   form as the existing Cognito entries, noting that the redirect URI must
   match a registered callback exactly — including trailing slash and scheme.

9. **Do not run `sst deploy`.** This workstream changes infrastructure
   definitions; deploying is tag-triggered in CI (`deploy.yml`) and a laptop
   production deploy is refused by a stage guard. Verification here is
   `pnpm -r typecheck`, `pnpm -r lint`, and `pnpm -r build`.

## Tests

`infra` has no live-AWS test path — provisioning is verified by CI's deploy on
a tag, not by unit tests. These assert the **configuration** the module
produces, which is where the failure modes live, using the values the functions
return rather than a deployed stack.

1. **`createAuth` enables the OAuth flow toggle** — Assert
   `allowedOauthFlowsUserPoolClient` is `true`. Every other OAuth field is
   inert without it, and it is the easiest to omit.
2. **The client allows only the code flow** — Assert `allowedOauthFlows` equals
   `['code']` exactly, and does **not** contain `'implicit'`. Implicit returns
   tokens in the URL fragment.
3. **The client requests openid, email, and profile** — Assert the exact scope
   set. Missing `openid` yields no id token, which is the only part the session
   uses.
4. **No client secret is generated** — Assert `generateSecret` is not enabled.
   A public browser client with a secret is a leaked secret.
5. **The callback URL is the app's `/auth/callback`** — Assert it equals
   `${appBaseUrl}/auth/callback` exactly, with no trailing slash. Cognito
   matches redirect URIs by exact string.
6. **The logout URL is registered** — Assert it appears in `logoutUrls`.
7. **Only the Cognito provider is supported** — Assert
   `supportedIdentityProviders` equals `['COGNITO']`, so adding a social
   provider later is a deliberate edit rather than an implicit default.
8. **Localhost callbacks are present outside production** — With a non-production
   stage, assert `http://localhost:3000/auth/callback` is registered.
9. **Localhost callbacks are absent in production** — With stage `production`,
   assert no `localhost` URL appears in `callbackUrls`. A registered localhost
   callback in production is an open redirect into an attacker's machine.
10. **A non-localhost `http` callback is refused** — Pass an `http://` base URL
    for a production stage; assert the function throws. Cognito permits `http`
    only for localhost, and failing here beats failing at deploy.
11. **The hosted-UI base URL is well formed** — Assert it starts with `https://`
    and contains `.auth.` and `.amazoncognito.com`.
12. **The redirect URI handed to the app matches a registered callback** —
    Assert the assertion helper passes for a matching pair and **throws** for a
    mismatched one. This is the check that turns a silent Cognito error page
    into a failed deploy.
13. **`docs/environment.md` documents the new variables** — Assert it mentions
    `COGNITO_HOSTED_UI_URL`, `COGNITO_REDIRECT_URI`, and `COGNITO_SIGN_OUT_URI`.

## Acceptance Criteria

1. `infra` passes all four scripts, and `pnpm -r typecheck`, `pnpm -r lint`,
   and `pnpm -r build` pass workspace-wide.
2. The Cognito client enables `allowedOauthFlowsUserPoolClient`, allows only
   the `code` flow, and requests `openid email profile` (tests 1–3). **SC-01.**
3. No client secret is generated (test 4).
4. Callback and logout URLs are absolute, derived from the app's base URL, and
   registered exactly as the app will send them (tests 5–6). **SC-07.**
5. Only `COGNITO` is a supported identity provider (test 7).
6. Localhost callbacks exist outside production and are absent in production
   (tests 8–9).
7. A non-localhost `http` callback throws rather than deploying (test 10).
8. The hosted-UI base URL is exported for WS-03 to build against (test 11).
9. A redirect URI that does not match a registered callback fails the deploy
   rather than producing a Cognito error page at runtime (test 12).
10. `docs/environment.md` documents all three new variables (test 13).
11. No application code is changed, and no `sst deploy` is run.
