import { SquareClient as SquareSdkClient, SquareEnvironment, SquareError } from 'square';
import type { SquareClient } from '@keki/contracts';
import { resolveSquareConfig } from './env';
import type { SquareConfig } from './env';
import { listCatalogItems } from './catalog';
import { createCheckout } from './checkout';
import { getPayment, refundPayment } from './payments';
import { verifySquareSignature } from './verify-signature';

// Carries the failing operation's name and Square's error category (when
// the failure came from the Square SDK) so callers can distinguish a
// retryable outage (e.g. API_ERROR) from a permanent rejection (e.g.
// INVALID_REQUEST_ERROR) without parsing message text.
export class SquareApiError extends Error {
  readonly kind = 'SquareApiError' as const;
  readonly operation: string;
  readonly category: string | undefined;

  constructor(operation: string, cause: unknown) {
    const category = cause instanceof SquareError ? cause.errors[0]?.category : undefined;
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(
      `Square API call "${operation}" failed${category !== undefined ? ` [${category}]` : ''}: ${causeMessage}`,
      { cause },
    );
    this.name = 'SquareApiError';
    this.operation = operation;
    this.category = category;
  }
}

async function wrapSquareCall<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new SquareApiError(operation, error);
  }
}

// Constructs the Square SDK client once and returns an object satisfying
// `SquareClient` from @keki/contracts — the only place in the workspace
// permitted to import the `square` SDK (see AGENTS.md "Module boundaries").
export function createSquareClient(overrides: Partial<SquareConfig> = {}): SquareClient {
  const config: SquareConfig = { ...resolveSquareConfig(), ...overrides };

  const sdk = new SquareSdkClient({
    token: config.accessToken,
    environment:
      config.environment === 'production' ? SquareEnvironment.Production : SquareEnvironment.Sandbox,
  });

  return {
    listCatalogItems: (input) =>
      wrapSquareCall('listCatalogItems', () => listCatalogItems(sdk, input ?? {})),
    createCheckout: (input) => wrapSquareCall('createCheckout', () => createCheckout(sdk, input)),
    getPayment: (input) => wrapSquareCall('getPayment', () => getPayment(sdk, input)),
    refundPayment: (input) => wrapSquareCall('refundPayment', () => refundPayment(sdk, input)),
    verifyWebhookSignature: (input) =>
      Promise.resolve(
        verifySquareSignature({
          rawBody: input.rawBody,
          signature: input.signature,
          notificationUrl: input.notificationUrl,
          signingKey: config.webhookSignatureKey,
        }),
      ),
  };
}
