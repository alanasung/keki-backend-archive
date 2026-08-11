import { randomUUID } from 'node:crypto';
import type { SquareClient } from '@keki/contracts';

// A Playwright suite must not call Square. This stub returns deterministic
// in-memory values instead, so using it in production would silently
// fabricate checkouts and payments — the same risk
// @keki/notification-core's createNoopProviders guards against for
// notification delivery — which is why it refuses to run there without an
// explicit override.
function assertStubAllowed(): void {
  const isProduction = process.env['NODE_ENV'] === 'production';
  const overrideFlag = process.env['KEKI_ALLOW_SQUARE_STUB'] === 'true';

  if (isProduction && !overrideFlag) {
    throw new Error(
      'createStubSquareClient: refusing to construct a stub Square client with NODE_ENV=production. ' +
        'The stub returns deterministic in-memory values instead of talking to Square, so using it in ' +
        'production would silently fabricate checkouts and payments. Set KEKI_ALLOW_SQUARE_STUB=true ' +
        'only if that is genuinely intended.',
    );
  }
}

export function createStubSquareClient(overrides?: Partial<SquareClient>): SquareClient {
  assertStubAllowed();

  const base: SquareClient = {
    listCatalogItems() {
      return Promise.resolve({ items: [], cursor: null });
    },
    createCheckout(input) {
      return Promise.resolve({
        checkoutUrl: `https://square.example/checkout/${input.orderId}`,
        squareOrderId: `stub-order-${randomUUID()}`,
      });
    },
    getPayment() {
      return Promise.resolve(null);
    },
    refundPayment() {
      return Promise.resolve({ refundId: `stub-refund-${randomUUID()}` });
    },
    verifyWebhookSignature() {
      return Promise.resolve(true);
    },
  };

  return { ...base, ...overrides };
}
