import { afterEach, describe, expect, it } from 'vitest';
import { createStubSquareClient } from './stub';

const originalNodeEnv = process.env['NODE_ENV'];
const originalOverride = process.env['KEKI_ALLOW_SQUARE_STUB'];

function restore(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

afterEach(() => {
  restore('NODE_ENV', originalNodeEnv);
  restore('KEKI_ALLOW_SQUARE_STUB', originalOverride);
});

describe('createStubSquareClient', () => {
  it('refuses to construct under NODE_ENV=production without the override flag', () => {
    process.env['NODE_ENV'] = 'production';
    delete process.env['KEKI_ALLOW_SQUARE_STUB'];

    expect(() => createStubSquareClient()).toThrow(/production/i);
  });

  it('constructs under NODE_ENV=production when the override flag is set', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['KEKI_ALLOW_SQUARE_STUB'] = 'true';

    expect(() => createStubSquareClient()).not.toThrow();
  });

  it('constructs outside production and returns deterministic values', async () => {
    process.env['NODE_ENV'] = 'test';
    delete process.env['KEKI_ALLOW_SQUARE_STUB'];

    const client = createStubSquareClient();

    await expect(client.listCatalogItems()).resolves.toEqual({ items: [], cursor: null });
    await expect(client.getPayment({ providerPaymentId: 'anything' })).resolves.toBeNull();
    await expect(
      client.verifyWebhookSignature({ rawBody: '', signature: '', notificationUrl: '' }),
    ).resolves.toBe(true);
  });
});
