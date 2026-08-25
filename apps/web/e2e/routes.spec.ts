// SC-04: every scaffolded route loads. Asserting the placeholder panel (not
// just a 200) is deliberate — see the WS-12 spec step 6 — it proves the route
// is scaffolded rather than accidentally rendering a blank body.
//
// Which routes are still placeholders is tracked in nav-config.test.ts; the
// two lists have to agree. `/book` (WS-08), `/account`, `/admin/offerings`
// (WS-06), `/admin/schedules` (WS-07), `/admin/reservations` (WS-08),
// `/staff/today`, `/staff/check-in`, `/staff/occupancy` (phase-4-staff-surfaces),
// and `/admin/customers` (phase-5-customer-onboarding) were built out into
// real pages and no longer render a placeholder panel, so they moved to the
// smoke block below.
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { createKioskContext, createRoleContext } from './fixtures/session';

async function withPage(
  contextFactory: () => Promise<BrowserContext>,
  run: (page: Page) => Promise<void>,
): Promise<void> {
  const context = await contextFactory();
  try {
    await run(await context.newPage());
  } finally {
    await context.close();
  }
}

async function expectScaffoldedPage(page: Page, path: string): Promise<void> {
  const response = await page.goto(path);
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByRole('status')).toBeVisible();
}

test.describe('placeholder routes', () => {
  test('/ redirects to /book', async ({ browser }) => {
    await withPage(
      () => createRoleContext(browser, 'CUSTOMER'),
      async (page) => {
        await page.goto('/');
        expect(new URL(page.url()).pathname).toBe('/book');
        await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      },
    );
  });

  for (const path of ['/kiosk/book', '/kiosk/waiver']) {
    test(`${path} renders with the kiosk device cookie`, async ({ browser }) => {
      await withPage(
        () => createKioskContext(browser, true),
        (page) => expectScaffoldedPage(page, path),
      );
    });
  }

});

// Built out past the placeholder stage. This is a load-bearing smoke check
// only — that the route still serves a page to its role rather than 500ing
// on a query, and that it has actually left the placeholder stage behind (no
// `PlaceholderPanel`, which every one of these routes rendered before its own
// workstream built it out). `/book`'s and `/account`'s actual behaviour is
// covered by ordering.spec.ts and customer-onboarding.spec.ts (completing a
// profile, adding a child, and booking them); the admin catalog surfaces' by
// admin-catalog.spec.ts; the staff surfaces' by staff-check-in.spec.ts.
// `/admin/customers` has no dedicated journey spec — this smoke check (a
// MANAGER reaching it, and no PlaceholderPanel) is its only e2e coverage;
// its query logic is covered at the unit level by page.test.tsx.
async function expectBuiltOutPage(page: Page, path: string): Promise<void> {
  const response = await page.goto(path);
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByText('This surface is not built yet.')).toHaveCount(0);
}

test.describe('built-out routes', () => {
  for (const path of ['/book', '/account']) {
    test(`${path} renders for CUSTOMER`, async ({ browser }) => {
      await withPage(
        () => createRoleContext(browser, 'CUSTOMER'),
        (page) => expectBuiltOutPage(page, path),
      );
    });
  }

  for (const path of ['/admin/offerings', '/admin/schedules', '/admin/reservations', '/admin/customers']) {
    test(`${path} renders for MANAGER`, async ({ browser }) => {
      await withPage(
        () => createRoleContext(browser, 'MANAGER'),
        (page) => expectBuiltOutPage(page, path),
      );
    });
  }

  for (const path of ['/staff/today', '/staff/check-in', '/staff/occupancy']) {
    test(`${path} renders for FRONT_OF_HOUSE`, async ({ browser }) => {
      await withPage(
        () => createRoleContext(browser, 'FRONT_OF_HOUSE'),
        (page) => expectBuiltOutPage(page, path),
      );
    });
  }
});
