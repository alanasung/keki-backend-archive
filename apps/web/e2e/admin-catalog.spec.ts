// SC-16, SC-07: the program's whole claim is that publishing in
// /admin/offerings and scheduling in /admin/schedules actually produces a
// bookable class on /book. Every other spec in this program verifies one
// surface; this one verifies the pieces connect, signed in as the seeded
// MANAGER (its first use anywhere in the e2e suite) and then as the seeded
// CUSTOMER for the negative and positive booking-page assertions.
//
// Runs serially and shares a `BrowserContext` across the manager-side tests:
// each step depends on the offering/occurrence the previous step created —
// this is one continuous journey split into named assertions, not
// independent tests that happen to share fixtures.
import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { E2E_ADMIN_CATALOG_NAME_PREFIX, resetAdminCatalogOfferings } from './fixtures/seed';
import { createRoleContext } from './fixtures/session';

test.describe.configure({ mode: 'serial' });

const currencyFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

// A generated name per run (SC-16 test 8): asserting on a fixed or
// leftover-from-demo-seed name is the easiest way for this journey to be
// green while proving nothing about the create-to-bookable path it exists to
// cover.
const CLASS_NAME = `${E2E_ADMIN_CATALOG_NAME_PREFIX} ${crypto.randomUUID()}`;
const CLASS_DURATION_MINUTES = '60';
const CLASS_CAPACITY = '5';
// Dollars, as a manager would type them — the round trip through integer
// cents and back is what test 7 (SC-16) exists to prove.
const CLASS_PRICE_DOLLARS = '45.50';
const CLASS_PRICE_CENTS = 4550;

function futureDatetimeLocalValue(daysFromNow: number): string {
  const date = new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 16);
}

let managerContext: BrowserContext;
let managerPage: Page;

test.afterAll(async () => {
  await resetAdminCatalogOfferings(E2E_ADMIN_CATALOG_NAME_PREFIX);
  await managerContext?.close();
});

test('a manager creates a class, which appears as DRAFT (tests 3, 8)', async ({ browser }) => {
  managerContext = await createRoleContext(browser, 'MANAGER');
  managerPage = await managerContext.newPage();
  await managerPage.goto('/admin/offerings');

  await managerPage.getByLabel('Name').fill(CLASS_NAME);
  await managerPage.getByLabel('Duration (minutes)').fill(CLASS_DURATION_MINUTES);
  await managerPage.getByLabel('Capacity').fill(CLASS_CAPACITY);
  await managerPage.getByLabel('Price (USD)').fill(CLASS_PRICE_DOLLARS);
  await managerPage.getByRole('button', { name: 'Create offering' }).click();

  const row = managerPage.locator('li', { hasText: CLASS_NAME });
  await expect(row).toBeVisible();
  await expect(row.getByText('Draft', { exact: true })).toBeVisible();
  await expect(row).toContainText(currencyFormatter.format(CLASS_PRICE_CENTS / 100));
});

test('publishing changes the status to PUBLISHED (test 4)', async () => {
  const row = managerPage.locator('li', { hasText: CLASS_NAME });
  await row.getByRole('button', { name: 'Publish' }).click();

  await expect(row.getByText('Published', { exact: true })).toBeVisible();
});

test('a manager schedules an occurrence, which appears with 0 booked (test 5)', async () => {
  await managerPage.goto('/admin/schedules');

  await managerPage.getByLabel('Offering').selectOption({ label: CLASS_NAME });
  await managerPage.getByLabel('Start').fill(futureDatetimeLocalValue(3));
  await managerPage.getByRole('button', { name: 'Schedule' }).click();

  const row = managerPage.locator('li', { hasText: CLASS_NAME });
  await expect(row).toBeVisible();
  await expect(row).toContainText(`0 / ${CLASS_CAPACITY} booked`);
});

test('the scheduled class appears on /book for a customer with its price and full seat count (tests 6, 7)', async ({
  browser,
}) => {
  const customerContext = await createRoleContext(browser, 'CUSTOMER');
  const customerPage = await customerContext.newPage();
  try {
    await customerPage.goto('/book');

    const classCard = customerPage.locator('article', { hasText: CLASS_NAME });
    await expect(classCard).toBeVisible();
    // The dollars -> integer cents -> dollars round trip (SC-16 test 7): the
    // admin form took "45.50", and this must render identically, not merely
    // an equivalent-valued string.
    await expect(classCard).toContainText(currencyFormatter.format(CLASS_PRICE_CENTS / 100));
    await expect(classCard).toContainText(`${CLASS_CAPACITY} seats left`);
  } finally {
    await customerContext.close();
  }
});

test('unpublishing removes the class from /book (test 9)', async ({ browser }) => {
  await managerPage.goto('/admin/offerings');
  const row = managerPage.locator('li', { hasText: CLASS_NAME });
  await row.getByRole('button', { name: 'Unpublish' }).click();
  await expect(row.getByText('Draft', { exact: true })).toBeVisible();

  const customerContext = await createRoleContext(browser, 'CUSTOMER');
  const customerPage = await customerContext.newPage();
  try {
    await customerPage.goto('/book');
    await expect(customerPage.locator('article', { hasText: CLASS_NAME })).toHaveCount(0);
  } finally {
    await customerContext.close();
  }
});

test('a CUSTOMER cannot reach /admin/offerings (test 10)', async ({ browser }) => {
  const customerContext = await createRoleContext(browser, 'CUSTOMER');
  const customerPage = await customerContext.newPage();
  try {
    await customerPage.goto('/admin/offerings');
    expect(new URL(customerPage.url()).pathname).toBe('/auth/unauthorized');
  } finally {
    await customerContext.close();
  }
});
