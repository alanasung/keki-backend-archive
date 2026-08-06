// Every secret this app needs, declared once so `infra/web.ts` and
// `infra/queues.ts` (via WS-11) link the same `sst.Secret` instances rather
// than redeclaring them under a second name.
export const SECRET_NAMES = [
  "NeonPooledUrl",
  "NeonDirectUrl",
  "SquareAccessToken",
  "SquareWebhookSignatureKey",
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
