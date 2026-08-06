// SC-04: all eleven placeholder routes load. Asserting the placeholder panel
// (not just a 200) is deliberate — see the WS-12 spec step 6 — it proves the
// route is scaffolded rather than accidentally rendering a blank body.
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

  for (const path of ['/book', '/account']) {
    test(`${path} renders for CUSTOMER`, async ({ browser }) => {
      await withPage(
        () => createRoleContext(browser, 'CUSTOMER'),
        (page) => expectScaffoldedPage(page, path),
      );
    });
  }

  for (const path of ['/kiosk/book', '/kiosk/waiver']) {
    test(`${path} renders with the kiosk device cookie`, async ({ browser }) => {
      await withPage(
        () => createKioskContext(browser, true),
        (page) => expectScaffoldedPage(page, path),
      );
    });
  }

  for (const path of ['/staff/today', '/staff/check-in', '/staff/occupancy']) {
    test(`${path} renders for FRONT_OF_HOUSE`, async ({ browser }) => {
      await withPage(
        () => createRoleContext(browser, 'FRONT_OF_HOUSE'),
        (page) => expectScaffoldedPage(page, path),
      );
    });
  }

  for (const path of ['/admin/offerings', '/admin/schedules', '/admin/reservations', '/admin/customers']) {
    test(`${path} renders for MANAGER`, async ({ browser }) => {
      await withPage(
        () => createRoleContext(browser, 'MANAGER'),
        (page) => expectScaffoldedPage(page, path),
      );
    });
  }
});
