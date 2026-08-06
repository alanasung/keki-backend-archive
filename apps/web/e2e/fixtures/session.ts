// Playwright fixture module: given a role (or the anonymous/unprovisioned/
// kiosk variants), produces a browser context carrying the cookies WS-04 and
// WS-09 read. Exported as plain async functions rather than `test.extend`
// fixtures because the role is a per-test parameter, not a fixed fixture
// set — see the WS-12 spec step 5.
import { ID_TOKEN_COOKIE_NAME } from '@keki/auth/cookies';
import type { Role } from '@keki/contracts';
import type { Browser, BrowserContext } from '@playwright/test';
import { signIdToken } from './jwks-server';
import { TEST_USERS, UNPROVISIONED_COGNITO_SUB, type TestUser } from './seed';
import { BASE_URL, COGNITO_CLIENT_ID, KIOSK_DEVICE_COOKIE_NAME, KIOSK_DEVICE_TOKEN } from './test-env';

async function contextWithIdTokenCookie(browser: Browser, cognitoSub: string, email?: string): Promise<BrowserContext> {
  const token = await signIdToken({ cognitoSub, audience: COGNITO_CLIENT_ID, ...(email !== undefined ? { email } : {}) });
  const context = await browser.newContext();
  await context.addCookies([{ name: ID_TOKEN_COOKIE_NAME, value: token, url: BASE_URL }]);
  return context;
}

/**
 * A context for the seeded test user of `role`. Requires `seedTestUsers()`
 * (from `./seed`) to have already run — normally done once in
 * `global-setup.ts` — since a cookie alone resolves to `unprovisioned`, not
 * `authenticated` (WS-04).
 */
export async function createRoleContext(browser: Browser, role: Role): Promise<BrowserContext> {
  const user: TestUser = TEST_USERS[role];
  return contextWithIdTokenCookie(browser, user.cognitoSub, user.email);
}

/** A signed, verifiable token cookie for a cognitoSub with no seeded profile row — the `unprovisioned` case. */
export async function createUnprovisionedContext(browser: Browser): Promise<BrowserContext> {
  return contextWithIdTokenCookie(browser, UNPROVISIONED_COGNITO_SUB);
}

/** No id-token cookie at all — the `anonymous` case. */
export async function createAnonymousContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext();
}

/**
 * The kiosk surface is device-scoped, not user-scoped (see
 * `app/auth/guards.ts`'s `requireKioskDevice`): `withDevice: true` sets the
 * cookie matching `KIOSK_DEVICE_TOKEN`, the value the `webServer` env also
 * supplies (see `playwright.config.ts`).
 */
export async function createKioskContext(browser: Browser, withDevice: boolean): Promise<BrowserContext> {
  const context = await browser.newContext();
  if (withDevice) {
    await context.addCookies([{ name: KIOSK_DEVICE_COOKIE_NAME, value: KIOSK_DEVICE_TOKEN, url: BASE_URL }]);
  }
  return context;
}
