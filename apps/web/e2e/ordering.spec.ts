// SC-15: browse -> participant selection -> cart review -> checkout redirect,
// against the stub Square client (never the real one — see
// playwright.config.ts's KEKI_ALLOW_SQUARE_STUB and
// fixtures/square-stub.ts). Booked by a customer whose household includes a
// child (fixtures/seed.ts's E2E_CHILD), not the account holder — a journey
// that only ever books the signed-in customer would pass even if
// participant selection were broken for the case the product exists to
// serve.
//
// Runs serially: every test in this file shares TEST_USERS.CUSTOMER's
// household (cart cookies are per-BrowserContext and so are already
// independent per test, but the order-count assertions in the price-tamper
// test read that household's orders table directly and would race against
// the happy-path test's real order if the two ran in parallel).
import { createHmac } from 'node:crypto';
import { customers, db, orders } from '@keki/database';
import { eq } from 'drizzle-orm';
import { expect, test } from '@playwright/test';
import { E2E_CAFE_ITEM, E2E_CHILD_DISPLAY_NAME, E2E_CLASS_OFFERING, TEST_USERS } from './fixtures/seed';
import { createRoleContext } from './fixtures/session';
import { interceptSquareCheckout, SQUARE_STUB_CHECKOUT_ORIGIN } from './fixtures/square-stub';
import { CART_COOKIE_SECRET } from './fixtures/test-env';

test.describe.configure({ mode: 'serial' });

// Same cookie name as apps/web/app/(customer)/cart/cart-cookie.ts's
// CART_COOKIE_NAME, kept as a literal rather than imported — this directory
// is the documented exemption for importing @keki/database (see
// fixtures/seed.ts's header comment), not for reaching into apps/web/app/'s
// internals generally.
const CART_COOKIE_NAME = 'keki_cart';

const currencyFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

function formatCents(cents: number): string {
  return currencyFormatter.format(cents / 100);
}

// Mirrors cart-cookie.ts's `sign`: base64url(JSON) + '.' + HMAC-SHA256 hex of
// the payload. Used to build a cookie the server accepts as authentically
// signed, so the price-tamper test proves the *schema*, not merely the
// signature check, rejects a client-supplied price.
function signedCartCookie(cart: unknown): string {
  const payload = Buffer.from(JSON.stringify(cart), 'utf-8').toString('base64url');
  const signature = createHmac('sha256', CART_COOKIE_SECRET).update(payload).digest('hex');
  return `${payload}.${signature}`;
}

async function householdIdFor(cognitoSub: string): Promise<string> {
  const rows = await db.select({ householdId: customers.householdId }).from(customers).where(eq(customers.cognitoSub, cognitoSub)).limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`householdIdFor: no seeded customer for cognitoSub "${cognitoSub}".`);
  }
  return row.householdId;
}

async function countOrdersForHousehold(householdId: string): Promise<number> {
  const rows = await db.select({ id: orders.id }).from(orders).where(eq(orders.householdId, householdId));
  return rows.length;
}

test('browse renders the seeded cafe item and class occurrence with prices and seats', async ({ browser }) => {
  const context = await createRoleContext(browser, 'CUSTOMER');
  const page = await context.newPage();
  try {
    await page.goto('/book');

    const cafeCard = page.locator('article', { hasText: E2E_CAFE_ITEM.name });
    await expect(cafeCard).toBeVisible();
    await expect(cafeCard).toContainText(formatCents(E2E_CAFE_ITEM.priceCents));

    const classCard = page.locator('article', { hasText: E2E_CLASS_OFFERING.name });
    await expect(classCard).toBeVisible();
    await expect(classCard).toContainText(formatCents(E2E_CLASS_OFFERING.priceCents));
    await expect(classCard).toContainText(/\d+ seats? left/);
  } finally {
    await context.close();
  }
});

test('browse -> add cafe item -> select child for a class -> cart -> checkout redirects to the stub', async ({
  browser,
}) => {
  const householdId = await householdIdFor(TEST_USERS.CUSTOMER.cognitoSub);
  const context = await createRoleContext(browser, 'CUSTOMER');
  const page = await context.newPage();
  try {
    await interceptSquareCheckout(page);
    await page.goto('/book');

    // Add a cafe item to the cart.
    const cafeCard = page.locator('article', { hasText: E2E_CAFE_ITEM.name });
    await cafeCard.getByRole('button', { name: 'Add to cart' }).click();
    await expect(cafeCard.getByRole('status')).toHaveText('Added to cart.');

    // Open the participant picker for the class and select the seeded child
    // — not the account holder, so this genuinely exercises participant
    // selection.
    const classCard = page.locator('article', { hasText: E2E_CLASS_OFFERING.name });
    await classCard.getByLabel(E2E_CHILD_DISPLAY_NAME).check();
    await classCard.getByRole('button', { name: 'Book seats' }).click();
    await expect(classCard.getByRole('status')).toHaveText('Seats added to cart.');

    // Review: the server-computed subtotal must match values computed here
    // from the seeded prices, not read off the page and compared to itself.
    await page.goto('/cart');

    const cafeLine = page.locator('li', { hasText: E2E_CAFE_ITEM.name });
    await expect(cafeLine).toContainText('Qty 1');
    await expect(cafeLine).toContainText(formatCents(E2E_CAFE_ITEM.priceCents));

    const classLine = page.locator('li', { hasText: E2E_CLASS_OFFERING.name });
    await expect(classLine).toContainText(`For: ${E2E_CHILD_DISPLAY_NAME}`);
    await expect(classLine).toContainText(formatCents(E2E_CLASS_OFFERING.priceCents));

    const expectedSubtotalCents = E2E_CAFE_ITEM.priceCents + E2E_CLASS_OFFERING.priceCents;
    const subtotalRow = page.getByText('Subtotal', { exact: true }).locator('..');
    await expect(subtotalRow).toContainText(formatCents(expectedSubtotalCents));

    const ordersBefore = await countOrdersForHousehold(householdId);

    // SC-15: checkout redirects to the stub's checkout URL.
    await page.getByRole('button', { name: 'Checkout' }).click();
    await page.waitForURL((url) => url.origin === SQUARE_STUB_CHECKOUT_ORIGIN && url.pathname.startsWith('/checkout/'));

    const ordersAfter = await countOrdersForHousehold(householdId);
    expect(ordersAfter).toBe(ordersBefore + 1);
  } finally {
    await context.close();
  }
});

test('a forged cart cookie carrying unitPriceCents is rejected end to end and creates no order', async ({
  browser,
}) => {
  const householdId = await householdIdFor(TEST_USERS.CUSTOMER.cognitoSub);
  const context = await createRoleContext(browser, 'CUSTOMER');
  const page = await context.newPage();
  try {
    // Reach a real, valid cart with a checkout button rendered.
    await page.goto('/book');
    const cafeCard = page.locator('article', { hasText: E2E_CAFE_ITEM.name });
    await cafeCard.getByRole('button', { name: 'Add to cart' }).click();
    await expect(cafeCard.getByRole('status')).toHaveText('Added to cart.');

    await page.goto('/cart');
    const checkoutButton = page.getByRole('button', { name: 'Checkout' });
    await expect(checkoutButton).toBeVisible();

    // Swap in a forged cookie: the same line, but carrying a client-supplied
    // unitPriceCents. cartSchema's CATALOG_ITEM line is `.strict()` — no
    // price field exists to tamper with — so this fails schema validation
    // entirely and readCart() resolves it as an empty cart, not a
    // cheap-priced one. A validly-computed signature (using the same secret
    // the server does) proves this is the schema rejecting the shape, not
    // merely a signature mismatch.
    const forgedCart = {
      lines: [{ kind: 'CATALOG_ITEM', catalogItemId: E2E_CAFE_ITEM.id, quantity: 1, unitPriceCents: 1 }],
    };
    await context.addCookies([
      { name: CART_COOKIE_NAME, value: signedCartCookie(forgedCart), url: page.url() },
    ]);

    const ordersBefore = await countOrdersForHousehold(householdId);

    await checkoutButton.click();
    await expect(page.getByRole('alert')).toHaveText('Your cart is empty.');
    expect(new URL(page.url()).pathname).toBe('/cart');

    const ordersAfter = await countOrdersForHousehold(householdId);
    expect(ordersAfter).toBe(ordersBefore);
  } finally {
    await context.close();
  }
});
