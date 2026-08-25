// SC-18: the program's whole claim is that a brand-new Cognito account —
// verified, but with no `customers` row — can complete a profile, add a
// child, and book that child into a class, and that the newly added child is
// what makes the booking possible (SC-15). Every other workstream in this
// program verifies its own surface in isolation — the complete-profile
// action, addChild/updateHousehold, the editable /account, /admin/customers;
// this is the one spec that proves they connect into a single journey,
// starting from `createUnprovisionedContext` (fixtures/session.ts) — a
// signed, verifiable token for a cognitoSub with no seeded profile, exactly
// what a brand-new account looks like.
//
// Runs serially and shares a `BrowserContext`/`Page`, mirroring
// admin-catalog.spec.ts and staff-check-in.spec.ts: each step depends on the
// state the previous one created (the household, then the child).
//
// `createUnprovisionedContext` is hardcoded to `UNPROVISIONED_COGNITO_SUB`
// (fixtures/seed.ts) — the same cognitoSub auth.spec.ts's own "unprovisioned
// session" test relies on staying unprovisioned. Provisioning it is the
// point of this journey, so `resetUnprovisionedFixture()` runs both before
// (in case a previous crashed run left it provisioned) and after (so nothing
// that runs next inherits a provisioned fixture) — see that function's own
// comment in fixtures/seed.ts.
import { children, customers, db, households } from '@keki/database';
import { eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { E2E_CLASS_OFFERING, resetUnprovisionedFixture, UNPROVISIONED_COGNITO_SUB } from './fixtures/seed';
import { createRoleContext, createUnprovisionedContext } from './fixtures/session';
import { interceptSquareCheckout, SQUARE_STUB_CHECKOUT_ORIGIN } from './fixtures/square-stub';

test.describe.configure({ mode: 'serial' });

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(CURRENT_DIR, '..', '..', '..');

// Per-run unique (SC-15 test 7 / SC-18): asserting on a fixed or
// leftover-from-a-previous-run name is the easiest way for this journey to
// pass while proving nothing about the "a newly added child is bookable"
// claim it exists to cover. Phase 3's admin-catalog journey established the
// same discipline for its offering name.
const CHILD_FIRST_NAME = 'E2E-Onboarding';
const CHILD_LAST_NAME = `Kiddo-${crypto.randomUUID()}`;
const CHILD_DISPLAY_NAME = `${CHILD_FIRST_NAME} ${CHILD_LAST_NAME}`;
const CHILD_DATE_OF_BIRTH = '2019-06-01';

const PROFILE_FIRST_NAME = 'E2E';
const PROFILE_LAST_NAME = 'Onboarding';

let context: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }) => {
  await resetUnprovisionedFixture();
  context = await createUnprovisionedContext(browser);
  page = await context.newPage();
});

test.afterAll(async () => {
  await context?.close();
  await resetUnprovisionedFixture();
});

test('an unprovisioned session visiting /book is redirected to complete-profile (test 1 — SC-08)', async () => {
  await page.goto('/book');
  expect(new URL(page.url()).pathname).toBe('/auth/complete-profile');
});

test('completing the profile provisions a household and lands back on /book (tests 2, 3 — SC-09)', async () => {
  await page.getByLabel('First name').fill(PROFILE_FIRST_NAME);
  await page.getByLabel('Last name').fill(PROFILE_LAST_NAME);
  await page.getByRole('button', { name: 'Complete profile' }).click();

  await page.waitForURL((url) => url.pathname === '/book');
});

test('revisiting /auth/complete-profile afterward redirects away without a second household (test 4 — SC-10)', async ({
  browser,
}) => {
  // A fresh context signed in with the same (now-provisioned) cognitoSub —
  // `createUnprovisionedContext` only controls the token, not the DB state
  // it resolves against.
  const revisitContext = await createUnprovisionedContext(browser);
  const revisitPage = await revisitContext.newPage();
  try {
    await revisitPage.goto('/auth/complete-profile');
    // `CompleteProfilePage` redirects an already-authenticated session
    // straight to /book rather than re-rendering the form — the form can
    // never be double-submitted through the UI once provisioned.
    await revisitPage.waitForURL((url) => url.pathname === '/book');
  } finally {
    await revisitContext.close();
  }

  const customerRows = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.cognitoSub, UNPROVISIONED_COGNITO_SUB));
  expect(customerRows).toHaveLength(1);

  const householdRows = await db
    .select({ id: households.id })
    .from(households)
    .where(eq(households.primaryCustomerId, customerRows[0]!.id));
  expect(householdRows).toHaveLength(1);
});

test('/account shows the new household with no children yet (test 5)', async () => {
  await page.goto('/account');

  // A household exists — otherwise the page would show "not linked to a
  // household yet" instead of the empty-children state (account/page.tsx),
  // and the assertion below would be testing a page that never reached that
  // branch.
  await expect(page.getByText('not linked to a household')).toHaveCount(0);
  await expect(page.getByText('Add your first child')).toBeVisible();
});

test('adding a child shows them on /account (tests 6, 7 — SC-11)', async () => {
  await page.getByLabel('First name').fill(CHILD_FIRST_NAME);
  await page.getByLabel('Last name').fill(CHILD_LAST_NAME);
  await page.getByLabel('Date of birth').fill(CHILD_DATE_OF_BIRTH);
  await page.getByRole('button', { name: 'Add child' }).click();

  await expect(page.getByText(CHILD_DISPLAY_NAME)).toBeVisible();
});

test('a future date of birth is refused through the whole stack, and adds no child (test 10 — SC-13)', async () => {
  // `max` on the date input is a client-side courtesy, not the guard (see
  // add-child-form.tsx's own comment) — removing it is what actually reaches
  // addChildSchema's real refusal, rather than only the browser's native
  // constraint-validation UI, which would block the click before the form's
  // onSubmit (and therefore the server action) ever ran.
  const dateInput = page.getByLabel('Date of birth');
  await dateInput.evaluate((element) => element.removeAttribute('max'));

  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const tomorrowValue = tomorrow.toISOString().slice(0, 10);

  await page.getByLabel('First name').fill('E2E-Future');
  await page.getByLabel('Last name').fill('ShouldNotExist');
  await dateInput.fill(tomorrowValue);
  await page.getByRole('button', { name: 'Add child' }).click();

  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByText('E2E-Future ShouldNotExist')).toHaveCount(0);

  const customerRows = await db
    .select({ householdId: customers.householdId })
    .from(customers)
    .where(eq(customers.cognitoSub, UNPROVISIONED_COGNITO_SUB));
  const childRows = await db.select({ id: children.id }).from(children).where(
    eq(children.householdId, customerRows[0]!.householdId),
  );
  expect(childRows).toHaveLength(1);
});

test('the newly added child is selectable in the booking participant picker (test 8 — SC-15 / SC-18)', async () => {
  await page.goto('/book');

  const classCard = page.locator('article', { hasText: E2E_CLASS_OFFERING.name });
  await expect(classCard).toBeVisible();
  await expect(classCard.getByLabel(CHILD_DISPLAY_NAME)).toBeVisible();
});

test('booking that child produces a reservation carrying their name (test 9 — the core of SC-18)', async () => {
  await interceptSquareCheckout(page);

  const classCard = page.locator('article', { hasText: E2E_CLASS_OFFERING.name });
  await classCard.getByLabel(CHILD_DISPLAY_NAME).check();
  await classCard.getByRole('button', { name: 'Book seats' }).click();
  await expect(classCard.getByRole('status')).toHaveText('Seats added to cart.');

  await page.goto('/cart');
  const classLine = page.locator('li', { hasText: E2E_CLASS_OFFERING.name });
  await expect(classLine).toContainText(`For: ${CHILD_DISPLAY_NAME}`);

  await page.getByRole('button', { name: 'Checkout' }).click();
  await page.waitForURL(
    (url) => url.origin === SQUARE_STUB_CHECKOUT_ORIGIN && url.pathname.startsWith('/checkout/'),
  );

  const orderId = new URL(page.url()).pathname.replace('/checkout/', '');
  await page.goto(`/orders/${orderId}`);
  await expect(page.getByText(`For: ${CHILD_DISPLAY_NAME}`)).toBeVisible();
});

// SC-17: the single most likely way this program breaks something unrelated
// — see the WS-09 spec step 3. These don't drive a browser; they assert the
// cookie contract directly, at the source and byte level.
test.describe('the cookie contract did not move (SC-17)', () => {
  test('createRoleContext still authenticates (test 13)', async ({ browser }) => {
    const roleContext = await createRoleContext(browser, 'CUSTOMER');
    const rolePage = await roleContext.newPage();
    try {
      const response = await rolePage.goto('/account');
      expect(response?.status()).toBe(200);
    } finally {
      await roleContext.close();
    }
  });

  test('fixtures/session.ts is byte-identical to its state when this program started (test 14)', () => {
    const relativePath = 'apps/web/e2e/fixtures/session.ts';
    const atHead = execFileSync('git', ['show', `HEAD:${relativePath}`], { cwd: REPO_ROOT, encoding: 'utf-8' });
    const current = readFileSync(join(REPO_ROOT, relativePath), 'utf-8');

    expect(current).toBe(atHead);
  });

  test('the callback writes the same cookie name the fixture sets, via ID_TOKEN_COOKIE_NAME, not a literal (test 15)', () => {
    const sessionFixtureSource = readFileSync(
      join(REPO_ROOT, 'apps/web/e2e/fixtures/session.ts'),
      'utf-8',
    );
    const sessionCookiesSource = readFileSync(
      join(REPO_ROOT, 'apps/web/app/auth/session-cookies.ts'),
      'utf-8',
    );
    const callbackSource = readFileSync(join(REPO_ROOT, 'apps/web/app/auth/callback/route.ts'), 'utf-8');

    // The fixture sets the cookie the browser carries; the callback (via
    // session-cookies.ts's setIdTokenCookie, which it calls) is what writes
    // it for real sign-ins. Both must resolve the name through the same
    // constant, imported from the same package, rather than each hardcoding
    // the literal — a renamed cookie in one place and not the other would
    // otherwise fail silently instead of at the type level.
    expect(sessionFixtureSource).toMatch(/ID_TOKEN_COOKIE_NAME/);
    expect(sessionFixtureSource).toMatch(/from ['"]@keki\/auth\/cookies['"]/);
    expect(sessionCookiesSource).toMatch(/ID_TOKEN_COOKIE_NAME/);
    expect(sessionCookiesSource).toMatch(/from ['"]@keki\/auth\/cookies['"]/);
    expect(callbackSource).toMatch(/setIdTokenCookie/);

    expect(sessionFixtureSource).not.toContain("'keki_id_token'");
    expect(callbackSource).not.toContain("'keki_id_token'");
  });
});
