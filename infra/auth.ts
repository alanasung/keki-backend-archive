// Cognito owns identity only. Postgres (via `@keki/auth`, WS-04) owns the
// `CUSTOMER` / `FRONT_OF_HOUSE` / `MANAGER` / `ADMIN` role assignment, so no
// Cognito group is declared here — a group would invite someone to read it
// as the authoritative role source later.
export const USER_POOL_NAME = "KekiUserPool";
export const USER_POOL_CLIENT_NAME = "KekiWebClient";

export const PASSWORD_POLICY = {
  minimumLength: 12,
  requireLowercase: true,
  requireUppercase: true,
  requireNumbers: true,
  requireSymbols: true,
} as const;

// Cognito matches redirect URIs by exact string and permits `http` only for
// `localhost` — every other origin must be `https`. Registered outside
// production so a developer stage works without hand-editing the console
// (AGENTS.md "Delivery").
export const LOCALHOST_APP_BASE_URL = "http://localhost:3000";

// `openid` yields the id token the session is built from; `email` and
// `profile` populate the claims `/auth/complete-profile` pre-fills from.
export const OAUTH_SCOPES = ["openid", "email", "profile"] as const;

export interface AuthResources {
  readonly userPool: sst.aws.CognitoUserPool;
  readonly client: sst.aws.CognitoUserPoolClient;
  readonly domain: aws.cognito.UserPoolDomain;
  /** What WS-03 builds authorization and logout URLs against. */
  readonly hostedUiBaseUrl: Output<string>;
  readonly redirectUri: Input<string>;
  readonly signOutUri: Input<string>;
  readonly callbackUrls: Input<string[]>;
}

export interface CreateAuthInput {
  readonly hostedUiDomainPrefix: string;
  readonly appBaseUrl: Input<string>;
}

function assertHttpsOrLocalhost(appBaseUrl: string): void {
  if (appBaseUrl.startsWith("https://") || appBaseUrl.startsWith(LOCALHOST_APP_BASE_URL)) {
    return;
  }
  throw new Error(
    `Refusing to configure Cognito OAuth: appBaseUrl "${appBaseUrl}" must use https, or be ` +
      `${LOCALHOST_APP_BASE_URL} for local development — Cognito permits http only for localhost.`,
  );
}

export function buildRedirectUri(appBaseUrl: string): string {
  assertHttpsOrLocalhost(appBaseUrl);
  return `${appBaseUrl}/auth/callback`;
}

export function buildSignOutUri(appBaseUrl: string): string {
  assertHttpsOrLocalhost(appBaseUrl);
  return `${appBaseUrl}/auth/sign-out/complete`;
}

// Local development runs at LOCALHOST_APP_BASE_URL, so a non-production
// stage additionally registers the localhost callback/logout pair — a
// registered localhost callback in production would be an open redirect
// into an attacker's machine, so it is included outside production only.
export function buildCallbackUrls(appBaseUrl: string, stage: string): string[] {
  const urls = [buildRedirectUri(appBaseUrl)];
  if (stage !== "production") {
    urls.push(`${LOCALHOST_APP_BASE_URL}/auth/callback`);
  }
  return urls;
}

export function buildLogoutUrls(appBaseUrl: string, stage: string): string[] {
  const urls = [buildSignOutUri(appBaseUrl)];
  if (stage !== "production") {
    urls.push(`${LOCALHOST_APP_BASE_URL}/auth/sign-out/complete`);
  }
  return urls;
}

// `appBaseUrl` is `Input<string>` — a plain string when the caller already
// has one (unit tests, this module's own helpers), or an `Output<string>`
// when it is a deploy-time secret (`infra/index.ts`'s `secrets.AppBaseUrl.value`).
// Handling both here keeps `buildRedirectUri`/`buildCallbackUrls`/etc. pure
// functions over plain strings, directly unit-testable without a Pulumi
// runtime.
function mapAppBaseUrl<T>(appBaseUrl: Input<string>, build: (resolved: string) => T): Input<T> {
  return typeof appBaseUrl === "string" ? build(appBaseUrl) : appBaseUrl.apply(build);
}

export function createAuth(input: CreateAuthInput): AuthResources {
  const { hostedUiDomainPrefix, appBaseUrl } = input;
  const stage = $app.stage;

  const userPool = new sst.aws.CognitoUserPool(USER_POOL_NAME, {
    usernames: ["email"],
    transform: {
      userPool: (args) => {
        args.passwordPolicy = { ...PASSWORD_POLICY };
        return undefined;
      },
    },
  });

  const redirectUri = mapAppBaseUrl(appBaseUrl, buildRedirectUri);
  const signOutUri = mapAppBaseUrl(appBaseUrl, buildSignOutUri);
  const callbackUrls = mapAppBaseUrl(appBaseUrl, (resolved) => buildCallbackUrls(resolved, stage));
  const logoutUrls = mapAppBaseUrl(appBaseUrl, (resolved) => buildLogoutUrls(resolved, stage));

  // `addClient`'s first-class options don't cover OAuth — `transform.client`
  // is the escape hatch onto the underlying `aws.cognito.UserPoolClient` args
  // (SST 3.19.3, AGENTS.md dependency pin). `generateSecret` is deliberately
  // left unset: the browser initiates this redirect, so a client secret
  // would have to be reachable from somewhere it could leak. PKCE is what
  // makes a public client safe, and Cognito supports it with no additional
  // client configuration.
  const client = userPool.addClient(USER_POOL_CLIENT_NAME, {
    transform: {
      client: (args) => {
        // Without this, every other OAuth field below is inert.
        args.allowedOauthFlowsUserPoolClient = true;
        // Not "implicit", which returns tokens in the URL fragment where
        // they land in browser history and referrer headers.
        args.allowedOauthFlows = ["code"];
        args.allowedOauthScopes = [...OAUTH_SCOPES];
        args.callbackUrls = callbackUrls;
        args.logoutUrls = logoutUrls;
        // Social login is out of scope; naming the provider explicitly
        // stops a later addition being implicit.
        args.supportedIdentityProviders = ["COGNITO"];
        return undefined;
      },
    },
  });

  // WS-09's sign-in placeholder will eventually redirect through this
  // hosted UI domain.
  const domain = new aws.cognito.UserPoolDomain(`${USER_POOL_NAME}Domain`, {
    domain: hostedUiDomainPrefix,
    userPoolId: userPool.id,
  });

  // Deriving this in the app from a domain prefix would duplicate a format
  // AWS owns.
  const hostedUiBaseUrl = $interpolate`https://${domain.domain}.auth.${aws.getRegionOutput().name}.amazoncognito.com`;

  return { userPool, client, domain, hostedUiBaseUrl, redirectUri, signOutUri, callbackUrls };
}

// The deploy-time counterpart to `queues.ts`'s `assertSquareNotificationUrlMatches`
// — the same class of failure this workstream risks. A redirect URI the app
// sends that Cognito never registered produces an error page from Cognito,
// not from the app, so it looks like an outage and gives no stack trace.
export function assertRedirectUriRegistered(redirectUri: string, callbackUrls: readonly string[]): void {
  if (!callbackUrls.includes(redirectUri)) {
    throw new Error(
      `Refusing to deploy: COGNITO_REDIRECT_URI ("${redirectUri}") is not among the Cognito client's ` +
        `registered callback URLs (${callbackUrls.join(", ")}). Redeploy once they agree.`,
    );
  }
}
