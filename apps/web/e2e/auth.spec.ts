// SC-05, automated: `staff/` and `admin/` require authentication and reject
// an unauthorized role. Each assertion distinguishes *which* denial page was
// reached (sign-in vs. unauthorized vs. complete-profile) rather than only
// checking that the protected page failed to render — see the WS-12 spec
// step 7 for why that distinction is the actual substance of this test.
import { expect, test } from '@playwright/test';
import {
  createAnonymousContext,
  createKioskContext,
  createRoleContext,
  createUnprovisionedContext,
} from './fixtures/session';
import { BASE_URL } from './fixtures/test-env';

// Mirrors fixtures/test-env.ts's COGNITO_HOSTED_UI_URL, which
// playwright.config.ts's webServer.env supplies to the running dev server —
// same rationale as COGNITO_CLIENT_ID below. The host doesn't need to
// resolve: this suite never follows the redirect. Kept as a literal rather
// than an import for the same reason CART_COOKIE_NAME is a literal in
// ordering.spec.ts.
const EXPECTED_HOSTED_UI_HOST = 'e2e-test.auth.us-east-1.amazoncognito.com';

// Same rationale: apps/web/app/auth/session-cookies.ts's
// OAUTH_STATE_COOKIE_NAME, not imported for the reason above.
const OAUTH_STATE_COOKIE_NAME = 'keki_oauth_state';

test.describe('authorization matrix', () => {
  // A single hop via `context.request` (not `page.goto`): WS-04's
  // `/auth/sign-in` is now a Route Handler that itself redirects on to
  // Cognito's hosted UI (a deliberately unresolvable test host — see
  // fixtures/test-env.ts), so a real browser navigation here would follow
  // straight through and never observe `/auth/sign-in` as a landing page at
  // all. What this test actually verifies — middleware's fast-path redirect
  // to `/auth/sign-in` with `next` round-tripped — is a single response, so
  // stopping at the first hop is the correct assertion, not a workaround.
  test('anonymous visiting /staff/today is redirected to sign-in with next round-tripped', async ({ browser }) => {
    const context = await createAnonymousContext(browser);
    const response = await context.request.get(`${BASE_URL}/staff/today`, { maxRedirects: 0 });
    expect(response.status()).toBe(307);
    // Middleware's same-origin redirect Location header comes back relative
    // (unlike /auth/sign-in's own redirect to Cognito's hosted UI, which is
    // absolute) — a base is required either way, and passing one is safe if
    // the header is ever absolute too.
    const url = new URL(response.headers()['location']!, BASE_URL);
    expect(url.pathname).toBe('/auth/sign-in');
    expect(url.searchParams.get('next')).toBe('/staff/today');
    await context.close();
  });

  test('anonymous visiting /admin/offerings is redirected to sign-in', async ({ browser }) => {
    const context = await createAnonymousContext(browser);
    const response = await context.request.get(`${BASE_URL}/admin/offerings`, { maxRedirects: 0 });
    expect(response.status()).toBe(307);
    const url = new URL(response.headers()['location']!, BASE_URL);
    expect(url.pathname).toBe('/auth/sign-in');
    expect(url.searchParams.get('next')).toBe('/admin/offerings');
    await context.close();
  });

  test('CUSTOMER visiting /staff/today is redirected to unauthorized, not sign-in', async ({ browser }) => {
    const context = await createRoleContext(browser, 'CUSTOMER');
    const page = await context.newPage();
    await page.goto('/staff/today');
    expect(new URL(page.url()).pathname).toBe('/auth/unauthorized');
    await context.close();
  });

  test('FRONT_OF_HOUSE visiting /admin/offerings is redirected to unauthorized', async ({ browser }) => {
    const context = await createRoleContext(browser, 'FRONT_OF_HOUSE');
    const page = await context.newPage();
    await page.goto('/admin/offerings');
    expect(new URL(page.url()).pathname).toBe('/auth/unauthorized');
    await context.close();
  });

  test('FRONT_OF_HOUSE visiting /staff/today renders', async ({ browser }) => {
    const context = await createRoleContext(browser, 'FRONT_OF_HOUSE');
    const page = await context.newPage();
    const response = await page.goto('/staff/today');
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await context.close();
  });

  test('ADMIN visiting /staff/today renders (role hierarchy)', async ({ browser }) => {
    const context = await createRoleContext(browser, 'ADMIN');
    const page = await context.newPage();
    const response = await page.goto('/staff/today');
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await context.close();
  });

  test('unprovisioned session visiting /account is redirected to complete-profile, not sign-in', async ({
    browser,
  }) => {
    const context = await createUnprovisionedContext(browser);
    const page = await context.newPage();
    await page.goto('/account');
    expect(new URL(page.url()).pathname).toBe('/auth/complete-profile');
    await context.close();
  });

  // Same single-hop rationale as the anonymous cases above.
  test('kiosk without the device cookie is redirected to sign-in', async ({ browser }) => {
    const context = await createKioskContext(browser, false);
    const response = await context.request.get(`${BASE_URL}/kiosk/book`, { maxRedirects: 0 });
    expect(response.status()).toBe(307);
    expect(new URL(response.headers()['location']!, BASE_URL).pathname).toBe('/auth/sign-in');
    await context.close();
  });

  test('kiosk with the device cookie renders', async ({ browser }) => {
    const context = await createKioskContext(browser, true);
    const page = await context.newPage();
    const response = await page.goto('/kiosk/book');
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await context.close();
  });

  // WS-09 (test 17): /admin/customers (WS-08) is the newest admin surface —
  // the other admin routes above are already covered by FRONT_OF_HOUSE and
  // CUSTOMER cases elsewhere in this matrix; this adds the CUSTOMER case for
  // the one route this program built out.
  test('CUSTOMER visiting /admin/customers is redirected to unauthorized', async ({ browser }) => {
    const context = await createRoleContext(browser, 'CUSTOMER');
    const page = await context.newPage();
    await page.goto('/admin/customers');
    expect(new URL(page.url()).pathname).toBe('/auth/unauthorized');
    await context.close();
  });
});

// WS-09 (tests 11, 12 — SC-01, SC-02): /auth/sign-in no longer renders a
// placeholder (WS-04 replaced it with a Route Handler); it redirects to
// Cognito's hosted UI. This asserts the redirect's shape — never follows
// it — because CI has no real user pool and Cognito's hosted UI is not ours
// to drive. The real token exchange is covered by unit tests against a
// stubbed token endpoint (packages/auth/src/oauth.test.ts); see
// docs/testing.md for the boundary this draws.
test.describe('/auth/sign-in redirects to the hosted UI (SC-01, SC-02)', () => {
  test('the redirect target carries response_type=code and a code_challenge, without being followed (test 11)', async ({
    request,
  }) => {
    const response = await request.get('/auth/sign-in', { maxRedirects: 0 });
    expect(response.status()).toBe(307);

    const location = response.headers()['location'];
    expect(location).toBeTruthy();
    const url = new URL(location!);

    expect(url.hostname).toBe(EXPECTED_HOSTED_UI_HOST);
    expect(url.pathname).toBe('/oauth2/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')?.length).toBeGreaterThan(0);
  });

  test('the redirect carries a state and sets the matching cookie (test 12)', async ({ request }) => {
    const response = await request.get('/auth/sign-in', { maxRedirects: 0 });
    const url = new URL(response.headers()['location']!);
    const state = url.searchParams.get('state');
    expect(state).toBeTruthy();

    const stateCookieHeader = response
      .headersArray()
      .find((header) => header.name.toLowerCase() === 'set-cookie' && header.value.startsWith(`${OAUTH_STATE_COOKIE_NAME}=`));
    expect(stateCookieHeader).toBeDefined();
    expect(stateCookieHeader?.value).toContain(`${OAUTH_STATE_COOKIE_NAME}=${state}`);
  });
});
