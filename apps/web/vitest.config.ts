import { defineConfig } from 'vitest/config';

export default defineConfig({
  // tsconfig.json sets `"jsx": "preserve"` since Next's SWC compiler owns
  // the real JSX transform in dev/build. Vitest's esbuild pipeline doesn't
  // go through SWC, and esbuild has no "preserve" mode, so without an
  // explicit override here it silently falls back to the classic transform
  // (`React.createElement` calls with no auto-import), which throws
  // `ReferenceError: React is not defined` the moment a test invokes a
  // layout or page component directly.
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    environment: 'node',
    include: ['app/**/*.test.ts', 'app/**/*.test.tsx', 'middleware.test.ts'],
    // Importing `@keki/auth`'s package root (as `guards.ts` and
    // `require-session.ts` do) transitively evaluates `@keki/database`,
    // which resolves and validates its Neon connection strings at
    // module-load time (see packages/database/src/env.ts), and WS-03's
    // `oauth-env.ts`, which does the same for the OAuth handshake config.
    // These syntactically-valid placeholders satisfy those eager checks — no
    // test in this project performs a real query, JWKS fetch, or Cognito
    // redirect — mirroring how SST resource linking supplies the real
    // values in every other environment.
    env: {
      COGNITO_USER_POOL_ID: 'us-east-1_testPool01',
      COGNITO_CLIENT_ID: 'test-client-id',
      AWS_REGION: 'us-east-1',
      COGNITO_HOSTED_UI_URL: 'https://keki-test.auth.us-east-1.amazoncognito.com',
      COGNITO_REDIRECT_URI: 'https://app.keki.test/auth/callback',
      COGNITO_SIGN_OUT_URI: 'https://app.keki.test/auth/sign-out/complete',
      DATABASE_URL_POOLED: 'postgres://user:pass@ep-test-123-pooler.us-east-2.aws.neon.tech/db?sslmode=require',
      DATABASE_URL_DIRECT: 'postgres://user:pass@ep-test-123.us-east-2.aws.neon.tech/db?sslmode=require',
      // WS-09's cart cookie HMAC key. A test-only placeholder, mirroring the
      // Cognito/Neon placeholders above — no test signs a cookie meant to be
      // verified against a real deployment's secret.
      CART_COOKIE_SECRET: 'test-cart-cookie-secret-do-not-use-in-production',
    },
  },
});
