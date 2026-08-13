import { createHmac } from 'node:crypto';
import { createCatalogItemId, createCustomerId, createOccurrenceId, type Cart } from '@keki/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const CATALOG_ITEM_ID = createCatalogItemId('11111111-1111-4111-8111-111111111111');
const OCCURRENCE_ID = createOccurrenceId('22222222-2222-4222-8222-222222222222');
const CUSTOMER_ID = createCustomerId('33333333-3333-4333-8333-333333333333');

const TEST_SECRET = 'test-cart-cookie-secret-do-not-use-in-production';

interface StoredCookie {
  readonly value: string;
  readonly options?: Record<string, unknown>;
}

const { store } = vi.hoisted(() => ({ store: new Map<string, StoredCookie>() }));

vi.mock('next/headers', () => ({
  cookies: vi.fn(() =>
    Promise.resolve({
      get: (name: string) => store.get(name),
      set: (name: string, value: string, options: Record<string, unknown>) => {
        store.set(name, { value, options });
      },
      delete: (name: string) => {
        store.delete(name);
      },
    }),
  ),
}));

import { CART_COOKIE_NAME, clearCart, readCart, writeCart } from './cart-cookie';

function signPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

function buildCookieValue(body: unknown, secret = TEST_SECRET): string {
  const payload = Buffer.from(JSON.stringify(body), 'utf-8').toString('base64url');
  return `${payload}.${signPayload(payload, secret)}`;
}

function setRawCookie(value: string): void {
  store.set(CART_COOKIE_NAME, { value });
}

const VALID_CART: Cart = {
  lines: [{ kind: 'CATALOG_ITEM', catalogItemId: CATALOG_ITEM_ID, quantity: 2 }],
};

describe('cart-cookie', () => {
  beforeEach(() => {
    store.clear();
  });

  // Test 1
  it('round-trips a cart through write then read', async () => {
    await writeCart(VALID_CART);

    const result = await readCart();

    expect(result).toEqual(VALID_CART);
  });

  // Test 2
  it('yields an empty cart when a byte in the cookie is tampered with', async () => {
    await writeCart(VALID_CART);
    const stored = store.get(CART_COOKIE_NAME);
    if (stored === undefined) {
      throw new Error('expected a stored cookie');
    }
    const separatorIndex = stored.value.lastIndexOf('.');
    const payload = stored.value.slice(0, separatorIndex);
    const signature = stored.value.slice(separatorIndex + 1);
    const tamperedPayload = payload.slice(0, -1) + (payload.at(-1) === 'A' ? 'B' : 'A');
    setRawCookie(`${tamperedPayload}.${signature}`);

    await expect(readCart()).resolves.toEqual({ lines: [] });
  });

  // Test 3
  it('rejects an unsigned cookie', async () => {
    setRawCookie(Buffer.from(JSON.stringify(VALID_CART), 'utf-8').toString('base64url'));

    await expect(readCart()).resolves.toEqual({ lines: [] });
  });

  // Test 4
  it('yields an empty cart when the payload fails cartSchema (negative quantity)', async () => {
    setRawCookie(
      buildCookieValue({
        lines: [{ kind: 'CATALOG_ITEM', catalogItemId: CATALOG_ITEM_ID, quantity: -1 }],
      }),
    );

    await expect(readCart()).resolves.toEqual({ lines: [] });
  });

  // Test 5 — SC-04 at the cookie boundary.
  it('rejects a cookie carrying a price', async () => {
    setRawCookie(
      buildCookieValue({
        lines: [{ kind: 'CATALOG_ITEM', catalogItemId: CATALOG_ITEM_ID, quantity: 1, unitPriceCents: 500 }],
      }),
    );

    await expect(readCart()).resolves.toEqual({ lines: [] });
  });

  // Test 6 — proves seat count has one source.
  it('rejects a cookie carrying an occurrence quantity', async () => {
    setRawCookie(
      buildCookieValue({
        lines: [
          {
            kind: 'OCCURRENCE',
            occurrenceId: OCCURRENCE_ID,
            quantity: 2,
            participants: [{ kind: 'CUSTOMER', customerId: CUSTOMER_ID }],
          },
        ],
      }),
    );

    await expect(readCart()).resolves.toEqual({ lines: [] });
  });

  // Test 7
  it('sets httpOnly, sameSite lax, and a bounded maxAge', async () => {
    await writeCart(VALID_CART);

    const stored = store.get(CART_COOKIE_NAME);
    expect(stored?.options).toMatchObject({
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 60 * 60 * 24,
    });
    expect(stored?.options?.maxAge).toBeLessThanOrEqual(60 * 60 * 24);
  });

  it('returns an empty cart when no cookie is present', async () => {
    await expect(readCart()).resolves.toEqual({ lines: [] });
  });

  it('clearCart removes the cookie', async () => {
    await writeCart(VALID_CART);
    expect(store.has(CART_COOKIE_NAME)).toBe(true);

    await clearCart();

    expect(store.has(CART_COOKIE_NAME)).toBe(false);
  });
});
