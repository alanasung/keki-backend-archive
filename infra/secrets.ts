// Every secret this app needs, declared once so `infra/web.ts` and
// `infra/queues.ts` (via WS-11) link the same `sst.Secret` instances rather
// than redeclaring them under a second name.
export const SECRET_NAMES = [
  "NeonPooledUrl",
  "NeonDirectUrl",
  "SquareAccessToken",
  "SquareEnvironment",
  "SquareWebhookSignatureKey",
  // Configured, not derived: `infra/queues.ts` cannot read the webhook
  // Function URL back into that same function's own environment (the URL is
  // an output *of* the function), so this is set by hand after the first
  // deploy of a stage and checked for agreement on every deploy after
  // (`infra/index.ts`'s `assertSquareNotificationUrlMatches`).
  "SquareNotificationUrl",
  "CartCookieSecret",
  // Secret-shaped rather than derived from a request header on purpose —
  // WS-13's Square redirect URL must come from server configuration.
  "AppBaseUrl",
  "KlaviyoApiKey",
  "WaiverProviderApiKey",
  "KioskDeviceToken",
] as const;

export type SecretName = (typeof SECRET_NAMES)[number];

export type Secrets = Record<SecretName, sst.Secret>;

export function createSecrets(): Secrets {
  const entries = SECRET_NAMES.map((name) => [name, new sst.Secret(name)] as const);
  return Object.fromEntries(entries) as Secrets;
}
