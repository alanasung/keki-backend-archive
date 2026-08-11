import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { cartSchema, type Cart } from '@keki/contracts';
import { EMPTY_CART, toBrandedCart } from './cart-shape';

export const CART_COOKIE_NAME = 'keki_cart';
const CART_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24; // 24 hours

function cartSecret(): string {
  const secret = process.env.CART_COOKIE_SECRET;
  if (secret === undefined || secret.length === 0) {
    throw new Error('CART_COOKIE_SECRET is required to read or write the cart cookie.');
  }
  return secret;
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

// Constant-time comparison so a tampered signature cannot be brute-forced
// one byte at a time via response-time differences. A length mismatch is
// resolved before comparing bytes: timingSafeEqual throws on mismatched
// buffer lengths rather than returning false.
function verify(payload: string, signature: string, secret: string): boolean {
  const expected = Buffer.from(sign(payload, secret), 'hex');
  const actual = Buffer.from(signature, 'hex');
  if (expected.length !== actual.length) {
    return false;
  }
  return timingSafeEqual(expected, actual);
}

/**
 * Reads the cart cookie. Any failure — missing cookie, missing or invalid
 * signature, malformed JSON, or a payload that fails `cartSchema` (a
 * negative quantity, a client-supplied price, an occurrence line carrying a
 * `quantity` field) — resolves to an empty cart rather than throwing. A
 * tampered or corrupted cookie must not hard-fail a page render; the
 * signature only makes tampering detectable, not confidential (item ids are
 * not secret).
 */
export async function readCart(): Promise<Cart> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(CART_COOKIE_NAME)?.value;
  if (raw === undefined) {
    return EMPTY_CART;
  }

  const separatorIndex = raw.lastIndexOf('.');
  if (separatorIndex === -1) {
    return EMPTY_CART; // Unsigned: no signature segment to verify.
  }

  const payload = raw.slice(0, separatorIndex);
  const signature = raw.slice(separatorIndex + 1);
  if (!verify(payload, signature, cartSecret())) {
    return EMPTY_CART;
  }

  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
  } catch {
    return EMPTY_CART;
  }

  const parsed = cartSchema.safeParse(json);
  if (!parsed.success) {
    return EMPTY_CART;
  }

  return toBrandedCart(parsed.data);
}

/**
 * Signs and writes the cart cookie. Callers are expected to have already
 * validated `cart` through `cartSchema` (see actions.ts's `persistCart`) —
 * this function does not re-validate, since every write path in this
 * workstream already does.
 */
export async function writeCart(cart: Cart): Promise<void> {
  const payload = Buffer.from(JSON.stringify(cart), 'utf-8').toString('base64url');
  const signature = sign(payload, cartSecret());
  const cookieStore = await cookies();
  cookieStore.set(CART_COOKIE_NAME, `${payload}.${signature}`, {
    httpOnly: true,
    // `sameSite: 'lax'` rather than 'strict' is deliberate: WS-13's checkout
    // redirect returns the customer from Square's domain, and a strict
    // cookie would not be sent on that top-level navigation.
    sameSite: 'lax',
    secure: process.env.NODE_ENV !== 'development',
    maxAge: CART_COOKIE_MAX_AGE_SECONDS,
    path: '/',
  });
}

export async function clearCart(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(CART_COOKIE_NAME);
}
