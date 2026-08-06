import { ID_TOKEN_COOKIE_NAME } from '@keki/auth/cookies';
import { signIdToken, startJwksServer } from './fixtures/jwks-server';
import { seedTestUsers, TEST_USERS } from './fixtures/seed';
import { BASE_URL, COGNITO_CLIENT_ID } from './fixtures/test-env';

/**
 * Runs once before the test run. Order matters here only in the sense the
 * WS-12 spec calls out: the JWKS server must be listening, and the test
 * users must be seeded, before any spec (or the assertion below) makes a
 * real request — not because this file necessarily executes before the
 * Next.js dev server boots. `verify-token.ts`'s `JwtVerifier` fetches the
 * JWKS lazily on first `.verify()` call, not at construction, so it does
 * not matter which of {this file, the dev server} starts first; what matters
 * is that the JWKS server is already serving by the time a test signs in.
 */
export default async function globalSetup(): Promise<void> {
  await startJwksServer();
  await seedTestUsers();
  await assertServerConfiguredForTests();
}

/**
 * Guards against the confusing failure mode called out in the spec: with
 * `reuseExistingServer: !process.env.CI`, a `pnpm dev` server started
 * earlier (without these test overrides in its environment) would make
 * every authenticated e2e test fail with no obvious cause. Signs a token for
 * a seeded customer and requests a customer-only page; a 200 confirms the
 * running server's `@keki/auth` verifier is actually configured against this
 * JWKS server, rather than defaulting to a real Cognito issuer that this
 * token was never signed for.
 */
async function assertServerConfiguredForTests(): Promise<void> {
  const { cognitoSub, email } = TEST_USERS.CUSTOMER;
  const token = await signIdToken({ cognitoSub, audience: COGNITO_CLIENT_ID, email });

  const response = await fetch(`${BASE_URL}/book`, {
    headers: { cookie: `${ID_TOKEN_COOKIE_NAME}=${token}` },
    redirect: 'manual',
  });

  if (response.status !== 200) {
    throw new Error(
      `Expected an authenticated request to ${BASE_URL}/book to render (200), got ${response.status}. ` +
        'The running dev server is not configured for e2e tests — most likely it was started without ' +
        "COGNITO_ISSUER/COGNITO_JWKS_URI/COGNITO_CLIENT_ID pointing at this run's JWKS server. " +
        'If you have a `pnpm dev` server already running locally, stop it and let webServer start its own ' +
        '(or restart it via the `test:e2e` script) so it inherits the env from playwright.config.ts.',
    );
  }
}
