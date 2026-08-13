import type { Page } from '@playwright/test';

// Must match `createStubSquareClient`'s hardcoded checkout origin in
// packages/square-client/src/stub.ts. Kept as a literal here rather than
// imported: apps/web/e2e/ is Playwright-side test code driving the app over
// HTTP, and @keki/square-client is a server-only dependency of the app under
// test, not of this test runner.
export const SQUARE_STUB_CHECKOUT_ORIGIN = 'https://square.example';

/**
 * "An origin the test controls" (WS-12 spec step 2): the app really does
 * navigate the browser to `SQUARE_STUB_CHECKOUT_ORIGIN`, which does not
 * resolve on the public internet, so without this the navigation would hang
 * or fail on a DNS lookup rather than committing to a URL Playwright can
 * assert against. Route interception happens at the browser's network layer
 * before any real DNS resolution is attempted, so the test can fulfill the
 * request itself and let the navigation complete normally — proving the
 * redirect happened without ever leaving the test environment or contacting
 * Square. Must be called (once per page) before the checkout click that
 * triggers the navigation.
 */
export async function interceptSquareCheckout(page: Page): Promise<void> {
  await page.route(`${SQUARE_STUB_CHECKOUT_ORIGIN}/**`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><body>Stub Square checkout (WS-12 e2e)</body></html>',
    });
  });
}
