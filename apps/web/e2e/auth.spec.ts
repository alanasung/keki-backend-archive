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

test.describe('authorization matrix', () => {
  test('anonymous visiting /staff/today is redirected to sign-in with next round-tripped', async ({ browser }) => {
    const context = await createAnonymousContext(browser);
    const page = await context.newPage();
    await page.goto('/staff/today');
    const url = new URL(page.url());
    expect(url.pathname).toBe('/auth/sign-in');
    expect(url.searchParams.get('next')).toBe('/staff/today');
    await context.close();
  });

  test('anonymous visiting /admin/offerings is redirected to sign-in', async ({ browser }) => {
    const context = await createAnonymousContext(browser);
    const page = await context.newPage();
    await page.goto('/admin/offerings');
    const url = new URL(page.url());
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

  test('kiosk without the device cookie is redirected to sign-in', async ({ browser }) => {
    const context = await createKioskContext(browser, false);
    const page = await context.newPage();
    await page.goto('/kiosk/book');
    expect(new URL(page.url()).pathname).toBe('/auth/sign-in');
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
});
