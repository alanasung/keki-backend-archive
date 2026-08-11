import { describe, expect, it, vi } from 'vitest';
import type { SquareClient as SquareSdkClient } from 'square';
import { createOrderId } from '@keki/contracts';
import { createCheckout } from './checkout';
import { createSquareClient } from './client';

const ORDER_ID = createOrderId('11111111-1111-4111-8111-111111111111');

const baseInput = {
  orderId: ORDER_ID,
  lineItems: [{ name: 'Latte', quantity: 2, unitPriceCents: 450 }],
  currency: 'USD',
  idempotencyKey: 'idem-key-123',
  redirectUrl: 'https://example.com/confirmation',
};

function fakeSdk(createImpl: (request?: unknown) => unknown) {
  const listMock = vi.fn(() => Promise.resolve({ locations: [{ id: 'LOC1', status: 'ACTIVE' }] }));
  const createMock = vi.fn(createImpl);
  const sdk = {
    locations: { list: listMock },
    checkout: { paymentLinks: { create: createMock } },
  } as unknown as SquareSdkClient;
  return { sdk, listMock, createMock };
}

const successResponse = () =>
  Promise.resolve({ paymentLink: { url: 'https://square.link/abc', orderId: 'sq-order-1' } });

describe('createCheckout', () => {
  it('passes the idempotency key through to Square', async () => {
    const { sdk, createMock } = fakeSdk(successResponse);

    await createCheckout(sdk, baseInput);

    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'idem-key-123' }));
  });

  it('sets our order id as the Square order reference', async () => {
    const { sdk, createMock } = fakeSdk(successResponse);

    await createCheckout(sdk, baseInput);

    const request = createMock.mock.calls[0]?.[0] as { order?: { referenceId?: unknown } } | undefined;
    expect(request?.order?.referenceId).toBe(ORDER_ID);
  });

  it('returns squareOrderId, not a payment id', async () => {
    const { sdk } = fakeSdk(successResponse);

    const result = await createCheckout(sdk, baseInput);

    expect(result).toEqual({ checkoutUrl: 'https://square.link/abc', squareOrderId: 'sq-order-1' });
    expect(result).not.toHaveProperty('paymentId');
    expect(result).not.toHaveProperty('providerPaymentId');
  });

  it('resolves the location once via the account locations, without it appearing in SquareConfig', async () => {
    const { sdk, listMock } = fakeSdk(successResponse);

    await createCheckout(sdk, baseInput);

    expect(listMock).toHaveBeenCalledTimes(1);
  });
});

const hasSquareCredentials = Boolean(process.env['SQUARE_ACCESS_TOKEN']);

// Real round trip against a live Square sandbox account. Skipped unless
// SQUARE_ACCESS_TOKEN (and the rest of SquareConfig) are present in the
// environment, following the `describe.skipIf(!hasLiveDatabase)` convention
// already used for Neon in packages/database.
describe.skipIf(!hasSquareCredentials)('integration: Square sandbox round trip', () => {
  it('lists catalog items and creates a usable payment link', async () => {
    const client = createSquareClient();

    const catalog = await client.listCatalogItems();
    expect(catalog.cursor === null || typeof catalog.cursor === 'string').toBe(true);

    const checkout = await client.createCheckout({
      orderId: ORDER_ID,
      lineItems: [{ name: 'Sandbox Item', quantity: 1, unitPriceCents: 100 }],
      currency: 'USD',
      idempotencyKey: `square-client-integration-${Date.now()}`,
      redirectUrl: 'https://example.com/confirmation',
    });

    expect(checkout.checkoutUrl).toMatch(/^https:\/\//);
    expect(checkout.squareOrderId.length).toBeGreaterThan(0);
  });
});
