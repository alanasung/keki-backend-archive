import { createHmac, timingSafeEqual } from 'node:crypto';

// Square signs the concatenation of the notification URL and the raw
// request body, then base64-encodes the HMAC-SHA256 digest. The
// notification URL matters as much as the body: without it, a signature
// computed for one endpoint would verify against a replay to another.
export function verifySquareSignature(input: {
  rawBody: string;
  signature: string;
  signingKey: string;
  notificationUrl: string;
}): boolean {
  const expected = createHmac('sha256', input.signingKey)
    .update(input.notificationUrl + input.rawBody, 'utf8')
    .digest();
  const provided = Buffer.from(input.signature, 'base64');

  // Buffers of different length can never be equal, and comparing lengths is
  // not itself a timing leak — the signature's length is not secret.
  // `timingSafeEqual` throws on a length mismatch, so this guard must run
  // first. Never fall back to `===`, which leaks the position of the first
  // mismatching byte through response timing.
  if (expected.length !== provided.length) {
    return false;
  }

  return timingSafeEqual(expected, provided);
}
