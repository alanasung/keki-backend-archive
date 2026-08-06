import { defineConfig, devices } from '@playwright/test';
import { CA_CERT_PATH, ensureKeyMaterial, ISSUER, JWKS_URI } from './apps/web/e2e/fixtures/jwks-server';
import {
  AWS_REGION,
  BASE_URL,
  COGNITO_CLIENT_ID,
  COGNITO_USER_POOL_ID,
  KIOSK_DEVICE_TOKEN,
} from './apps/web/e2e/fixtures/test-env';

// Must complete before `webServer.env` (below) is constructed: the Next.js
// process reads `NODE_EXTRA_CA_CERTS` once at startup, so the certificate
// file it names has to exist already — generating it later, inside
// `globalSetup`, would be too late if the dev server happens to finish
// booting first. See `ensureKeyMaterial`'s doc comment in jwks-server.ts.
await ensureKeyMaterial();

const databaseUrlPooled = process.env['DATABASE_URL_POOLED'];
const databaseUrlDirect = process.env['DATABASE_URL_DIRECT'];

if (databaseUrlPooled === undefined || databaseUrlDirect === undefined) {
  throw new Error(
    'DATABASE_URL_POOLED and DATABASE_URL_DIRECT must be set in the environment before running Playwright: ' +
      "the seed fixture, the webServer's Next.js process, and the WS-03/06/07/11 integration tests all need a " +
      'real (test) Postgres branch. See docs/testing.md.',
  );
}

export default defineConfig({
  testDir: './apps/web/e2e',
  globalSetup: './apps/web/e2e/global-setup.ts',
  globalTeardown: './apps/web/e2e/global-teardown.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 2 : 0,
  reporter: [['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  // Chromium only in Phase 1 — see the spec's implementation step 4;
  // Firefox/WebKit projects arrive in Phase 2.
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm dev',
    url: BASE_URL,
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
    env: {
      // Standard Node/Next value ("test"), not a project-specific one — see
      // AGENTS.md and WS-04's `env.ts`, which permits the COGNITO_ISSUER /
      // COGNITO_JWKS_URI overrides only when NODE_ENV !== 'production'.
      NODE_ENV: 'test',
      COGNITO_ISSUER: ISSUER,
      COGNITO_JWKS_URI: JWKS_URI,
      COGNITO_USER_POOL_ID,
      COGNITO_CLIENT_ID,
      AWS_REGION,
      KIOSK_DEVICE_TOKEN,
      DATABASE_URL_POOLED: databaseUrlPooled,
      DATABASE_URL_DIRECT: databaseUrlDirect,
      // Trusts the JWKS server's self-signed certificate — see jwks-server.ts's
      // `ISSUER` doc comment for why the JWKS endpoint is HTTPS at all.
      NODE_EXTRA_CA_CERTS: CA_CERT_PATH,
    },
  },
});
