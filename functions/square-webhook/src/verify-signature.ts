import { createHmac, timingSafeEqual } from 'node:crypto';

// TODO(phase-2): This is generic HMAC-SHA256 verification over the raw body,
// NOT Square's actual webhook scheme — Square signs the concatenation of the
// notification URL and the raw body, then base64-encodes the HMAC. A real
// Square integration must implement that exact construction. Until then this
// Function URL must never be publicly reachable (see http.ts and
// infra/queues.ts, which grant it `authType: AWS_IAM` rather than `NONE`).
export function verifyWebhookSignature(input: {
  rawBody: string;
  signature: string;
  signingKey: string;
}): boolean {
  const expected = createHmac('sha256', input.signingKey).update(input.rawBody, 'utf8').digest();
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
