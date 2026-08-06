import { afterEach, describe, expect, it, vi } from 'vitest';

// Deliberately does NOT mock @keki/notification-core — this test exercises
// the real createNoopProviders() production guard, which handler.ts calls
// eagerly at module load so a Lambda deployed with NODE_ENV=production and
// no override fails at cold start rather than silently sending nothing (see
// handler.ts and packages/notification-core/src/providers.ts). Kept in its
// own file so this file's real, unmocked import of @keki/notification-core
// (which transitively imports @keki/database) never contaminates
// handler.test.ts's mocked suite.
describe('notification-worker production guard', () => {
  const originalNodeEnv = process.env['NODE_ENV'];

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env['NODE_ENV'];
    } else {
      process.env['NODE_ENV'] = originalNodeEnv;
    }
    delete process.env['DATABASE_URL_POOLED'];
    delete process.env['DATABASE_URL_DIRECT'];
    delete process.env['KEKI_ALLOW_NOOP_PROVIDERS'];
  });

  it('fails fast at import time when NODE_ENV=production and no override is set', async () => {
    // Valid-shaped but fake connection strings: @keki/database validates
    // both URLs eagerly at module load (see packages/database/src/env.ts),
    // so this handler's module chain cannot import at all without them —
    // no query is ever issued in this test.
    process.env['DATABASE_URL_POOLED'] = 'postgres://user:pass@ep-test-pooler.us-east-1.aws.neon.tech/db';
    process.env['DATABASE_URL_DIRECT'] = 'postgres://user:pass@ep-test.us-east-1.aws.neon.tech/db';
    process.env['NODE_ENV'] = 'production';
    delete process.env['KEKI_ALLOW_NOOP_PROVIDERS'];
    vi.resetModules();

    await expect(import('./handler')).rejects.toThrow(/refusing to construct no-op notification providers/);
  });
});
