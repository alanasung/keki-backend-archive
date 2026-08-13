/**
 * Literal test-only Cognito/kiosk configuration shared between
 * `playwright.config.ts` (which injects these into the `webServer`'s process
 * environment so WS-04's eager env validation succeeds) and the fixtures in
 * this directory (which sign tokens and set cookies that must agree with
 * those exact values). Kept in one module so the two sides cannot drift.
 */
export const COGNITO_USER_POOL_ID = 'us-east-1_e2eTestPool';
export const COGNITO_CLIENT_ID = 'e2e-test-client-id';
export const AWS_REGION = 'us-east-1';
export const KIOSK_DEVICE_TOKEN = 'e2e-test-kiosk-device-token';

export const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:3000';

// The web app's own public URL, for WS-13's Square checkout redirect
// (`APP_BASE_URL`). Same value as BASE_URL: during the e2e run, the app under
// test IS the origin the customer returns to.
export const APP_BASE_URL = BASE_URL;

// Signs the `keki_cart` cookie (apps/web/app/(customer)/cart/cart-cookie.ts).
// Any string works locally; this fixed value lets ordering.spec.ts's
// price-tamper test compute a validly-signed forged cookie itself, using the
// same HMAC-SHA256 scheme cart-cookie.ts does.
export const CART_COOKIE_SECRET = 'e2e-test-cart-cookie-secret';

// Not exported by `@keki/auth/cookies` — WS-09's `guards.ts` keeps this
// constant local to itself since only the kiosk layout reads it. Duplicated
// here (as a literal, not an import) because that file lives under
// `apps/web/app/`, and this fixture needs the name without pulling in the
// rest of the app's guard logic.
export const KIOSK_DEVICE_COOKIE_NAME = 'keki_kiosk_device';
