import type { AuthResources } from "./auth";
import type { Secrets } from "./secrets";

// The environment variables `@keki/database`, `@keki/auth`, apps/web's
// kiosk guard, and (WS-11) its cart cookie and Square redirect base URL
// require, mapped to where each value comes from. `NeonPooledUrl` →
// `DATABASE_URL_POOLED` and `NeonDirectUrl` → `DATABASE_URL_DIRECT` —
// swapped, the app sends traffic to the direct endpoint (exhausting
// connections) or runs DDL through the pooler (failing oddly), and WS-03's
// startup guard throws. `SQUARE_WEBHOOK_SIGNATURE_KEY`, `SQUARE_ACCESS_TOKEN`,
// `SQUARE_ENVIRONMENT`, `SQUARE_NOTIFICATION_URL`, and
// `KEKI_ALLOW_NOOP_PROVIDERS` are function-scoped (`queues.ts`'s to map) and
// deliberately absent here — the Next.js app never gets a direct Square
// credential; Server Actions that need one construct their own
// `square-client`. `AWS_REGION` (which `@keki/auth` also reads) is
// deliberately NOT set: it is a reserved Lambda key — CreateFunction rejects
// it outright — and Lambda injects it automatically with the function's own
// region. The build step gets it from the deploy environment instead.
export const WEB_ENV_MAPPING = {
  DATABASE_URL_POOLED: "NeonPooledUrl",
  DATABASE_URL_DIRECT: "NeonDirectUrl",
  COGNITO_USER_POOL_ID: "cognitoUserPoolId",
  COGNITO_CLIENT_ID: "cognitoClientId",
  KIOSK_DEVICE_TOKEN: "KioskDeviceToken",
  CART_COOKIE_SECRET: "CartCookieSecret",
  APP_BASE_URL: "AppBaseUrl",
} as const;

export interface CreateWebParams {
  readonly secrets: Secrets;
  readonly auth: AuthResources;
}

export function createWeb(params: CreateWebParams): sst.aws.Nextjs {
  const { secrets, auth } = params;

  return new sst.aws.Nextjs("Web", {
    path: "apps/web",
    link: [
      secrets.NeonPooledUrl,
      secrets.NeonDirectUrl,
      secrets.KioskDeviceToken,
      secrets.CartCookieSecret,
      secrets.AppBaseUrl,
      auth.userPool,
    ],
    environment: {
      DATABASE_URL_POOLED: secrets.NeonPooledUrl.value,
      DATABASE_URL_DIRECT: secrets.NeonDirectUrl.value,
      COGNITO_USER_POOL_ID: auth.userPool.id,
      COGNITO_CLIENT_ID: auth.client.id,
      KIOSK_DEVICE_TOKEN: secrets.KioskDeviceToken.value,
      CART_COOKIE_SECRET: secrets.CartCookieSecret.value,
      APP_BASE_URL: secrets.AppBaseUrl.value,
    },
  });
}
