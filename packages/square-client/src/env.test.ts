import { describe, expect, it } from 'vitest';
import { resolveSquareConfig } from './env';

function envWith(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return {
    SQUARE_ACCESS_TOKEN: 'test-access-token',
    SQUARE_ENVIRONMENT: 'sandbox',
    SQUARE_WEBHOOK_SIGNATURE_KEY: 'test-signing-key',
    SQUARE_NOTIFICATION_URL: 'https://example.com/webhooks/square',
    ...overrides,
  };
}

describe('resolveSquareConfig', () => {
  it('resolves valid, complete configuration', () => {
    expect(resolveSquareConfig(envWith({}))).toEqual({
      accessToken: 'test-access-token',
      environment: 'sandbox',
      webhookSignatureKey: 'test-signing-key',
      notificationUrl: 'https://example.com/webhooks/square',
    });
  });

  it('throws naming SQUARE_ACCESS_TOKEN when it is missing', () => {
    expect(() => resolveSquareConfig(envWith({ SQUARE_ACCESS_TOKEN: undefined }))).toThrow(
      /SQUARE_ACCESS_TOKEN/,
    );
  });

  it('throws naming SQUARE_WEBHOOK_SIGNATURE_KEY when it is missing', () => {
    expect(() => resolveSquareConfig(envWith({ SQUARE_WEBHOOK_SIGNATURE_KEY: undefined }))).toThrow(
      /SQUARE_WEBHOOK_SIGNATURE_KEY/,
    );
  });

  it('throws naming SQUARE_NOTIFICATION_URL when it is missing', () => {
    expect(() => resolveSquareConfig(envWith({ SQUARE_NOTIFICATION_URL: undefined }))).toThrow(
      /SQUARE_NOTIFICATION_URL/,
    );
  });

  it('throws naming SQUARE_ENVIRONMENT when it is neither sandbox nor production', () => {
    expect(() => resolveSquareConfig(envWith({ SQUARE_ENVIRONMENT: 'staging' }))).toThrow(
      /SQUARE_ENVIRONMENT/,
    );
  });

  it('refuses SQUARE_ENVIRONMENT=sandbox when NODE_ENV=production', () => {
    expect(() =>
      resolveSquareConfig(envWith({ SQUARE_ENVIRONMENT: 'sandbox', NODE_ENV: 'production' })),
    ).toThrow(/production/i);
  });

  it('accepts SQUARE_ENVIRONMENT=production when NODE_ENV=production', () => {
    expect(() =>
      resolveSquareConfig(envWith({ SQUARE_ENVIRONMENT: 'production', NODE_ENV: 'production' })),
    ).not.toThrow();
  });

  it('accepts SQUARE_ENVIRONMENT=sandbox when NODE_ENV is not production', () => {
    expect(() =>
      resolveSquareConfig(envWith({ SQUARE_ENVIRONMENT: 'sandbox', NODE_ENV: 'test' })),
    ).not.toThrow();
  });
});
