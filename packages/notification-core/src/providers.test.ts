import { afterEach, describe, expect, it } from 'vitest';
import { createCustomerId } from '@keki/contracts';
import { createNoopProviders } from './providers';

describe('createNoopProviders', () => {
  const originalNodeEnv = process.env['NODE_ENV'];
  const originalOverride = process.env['KEKI_ALLOW_NOOP_PROVIDERS'];

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env['NODE_ENV'];
    } else {
      process.env['NODE_ENV'] = originalNodeEnv;
    }
    if (originalOverride === undefined) {
      delete process.env['KEKI_ALLOW_NOOP_PROVIDERS'];
    } else {
      process.env['KEKI_ALLOW_NOOP_PROVIDERS'] = originalOverride;
    }
  });

  it('refuses to construct in production without an override flag', () => {
    process.env['NODE_ENV'] = 'production';
    delete process.env['KEKI_ALLOW_NOOP_PROVIDERS'];

    expect(() => createNoopProviders()).toThrow(/production/);
  });

  it('allows production when KEKI_ALLOW_NOOP_PROVIDERS=true', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['KEKI_ALLOW_NOOP_PROVIDERS'] = 'true';

    expect(() => createNoopProviders()).not.toThrow();
  });

  it('allows non-production environments without the override flag', () => {
    process.env['NODE_ENV'] = 'test';
    delete process.env['KEKI_ALLOW_NOOP_PROVIDERS'];

    expect(() => createNoopProviders()).not.toThrow();
  });

  it('every provider logs and returns a synthetic noop-prefixed id', async () => {
    process.env['NODE_ENV'] = 'test';
    const providers = createNoopProviders();

    const emailResult = await providers.email.send({
      to: 'person@example.com',
      templateKey: 'welcome',
      payload: {},
      idempotencyKey: 'idem-1',
    });
    expect(emailResult.providerMessageId).toMatch(/^noop-/);

    const smsResult = await providers.sms.send({
      to: '+15555550123',
      templateKey: 'welcome',
      payload: {},
      idempotencyKey: 'idem-2',
    });
    expect(smsResult.providerMessageId).toMatch(/^noop-/);

    const marketingResult = await providers.marketing.send({
      to: 'person@example.com',
      templateKey: 'welcome',
      payload: {},
      idempotencyKey: 'idem-3',
    });
    expect(marketingResult.providerMessageId).toMatch(/^noop-/);

    await expect(
      providers.marketing.identify({
        customerId: createCustomerId('11111111-1111-4111-8111-111111111111'),
        traits: {},
      }),
    ).resolves.toBeUndefined();
  });
});
