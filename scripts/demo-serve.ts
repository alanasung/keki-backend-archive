import 'dotenv/config';
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';
import { ID_TOKEN_COOKIE_NAME } from '@keki/auth';
import {
  CA_CERT_PATH,
  ensureKeyMaterial,
  ISSUER,
  JWKS_URI,
  signIdToken,
  startJwksServer,
} from '../apps/web/e2e/fixtures/jwks-server';
import { seedTestUsers, TEST_USERS } from '../apps/web/e2e/fixtures/seed';
import {
  APP_BASE_URL,
  AWS_REGION,
  BASE_URL,
  CART_COOKIE_SECRET,
  COGNITO_CLIENT_ID,
  COGNITO_USER_POOL_ID,
  KIOSK_DEVICE_TOKEN,
} from '../apps/web/e2e/fixtures/test-env';

// Opens a real, clickable browser already signed in as a customer, on a dev
// server wired to a local JWKS issuer. Reuses the e2e fixtures wholesale
// rather than adding a development bypass to the auth path — `/book` sits
// behind the customer gate, and the safe way past it is a genuinely signed
// token from an issuer the app has been pointed at, not a hole in the guard.
//
// NODE_ENV is 'test' here, which is what makes the COGNITO_ISSUER /
// COGNITO_JWKS_URI overrides permissible at all: packages/auth refuses them
// under NODE_ENV=production, so this cannot be turned on against a real
// deployment.
//
// Run `pnpm db:migrate` and `pnpm demo:setup` first — this script serves the
// catalog that `demo:setup` synced; it does not sync anything itself.

const DEV_SERVER_READY_TIMEOUT_MS = 120_000;

function requireDatabaseUrls(): { pooled: string; direct: string } {
  const pooled = process.env['DATABASE_URL_POOLED'];
  const direct = process.env['DATABASE_URL_DIRECT'];
  if (pooled === undefined || direct === undefined) {
    throw new Error(
      'DATABASE_URL_POOLED and DATABASE_URL_DIRECT must be set (see .env.example). ' +
        'Run `pnpm db:migrate` and `pnpm demo:setup` before this script.',
    );
  }
  return { pooled, direct };
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url, { redirect: 'manual' });
      // Any HTTP answer means Next is listening; an auth redirect is still a
      // healthy server, so do not require 200 here.
      if (response.status > 0) {
        return;
      }
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      throw new Error(`Dev server did not become ready at ${url} within ${timeoutMs}ms.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function main(): Promise<void> {
  const { pooled, direct } = requireDatabaseUrls();

  console.log('1/4  Generating key material and starting the local JWKS server…');
  await ensureKeyMaterial();
  await startJwksServer();

  console.log('2/4  Seeding the demo customer…');
  await seedTestUsers();

  console.log('3/4  Starting the dev server…');
  const devServer = spawn('pnpm', ['dev'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      COGNITO_ISSUER: ISSUER,
      COGNITO_JWKS_URI: JWKS_URI,
      COGNITO_USER_POOL_ID,
      COGNITO_CLIENT_ID,
      AWS_REGION,
      KIOSK_DEVICE_TOKEN,
      DATABASE_URL_POOLED: pooled,
      DATABASE_URL_DIRECT: direct,
      NODE_EXTRA_CA_CERTS: CA_CERT_PATH,
      CART_COOKIE_SECRET,
      APP_BASE_URL,
      // Deliberately NOT setting KEKI_ALLOW_SQUARE_STUB: the point of this
      // demo is the real Square integration, so checkout builds a real
      // sandbox payment link. Set it to 'true' if you would rather clicking
      // checkout stay entirely local.
    },
  });

  const shutdown = (): void => {
    devServer.kill('SIGTERM');
  };
  process.on('SIGINT', () => {
    shutdown();
    process.exit(0);
  });

  await waitForServer(BASE_URL, DEV_SERVER_READY_TIMEOUT_MS);

  console.log('4/4  Opening a signed-in browser…');
  const idToken = await signIdToken({ cognitoSub: TEST_USERS.CUSTOMER.cognitoSub });

  const browser = await chromium.launch({
    headless: false,
    // The JWKS server presents a self-signed certificate; the browser never
    // talks to it (only the Next.js process does), but ignoring cert errors
    // keeps a stray request from interrupting the demo.
    ignoreHTTPSErrors: true,
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: null });

  const { hostname } = new URL(BASE_URL);
  await context.addCookies([
    {
      name: ID_TOKEN_COOKIE_NAME,
      value: idToken,
      domain: hostname,
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    },
  ]);

  const page = await context.newPage();
  await page.goto(`${BASE_URL}/book`);

  console.log(`\n  Signed in as ${TEST_USERS.CUSTOMER.email}`);
  console.log(`  Browse: ${BASE_URL}/book`);
  console.log(`  Cart:   ${BASE_URL}/cart`);
  console.log('\n  The browser stays open. Ctrl-C here to stop the dev server.\n');

  // Hold the process open so the dev server and browser outlive this script's
  // main path; Ctrl-C tears both down.
  await new Promise(() => {});
}

main().catch((error: unknown) => {
  console.error('demo-serve failed:', error);
  process.exitCode = 1;
});
