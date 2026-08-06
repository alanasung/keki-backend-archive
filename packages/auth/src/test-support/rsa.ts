import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import type { Jwk } from 'aws-jwt-verify/jwk';

/**
 * Test-only RSA key generation and JWT signing, so `verify-token.test.ts` and
 * `session.test.ts` can exercise real signature verification against a
 * locally generated key — no network, no real Cognito pool. `aws-jwt-verify`
 * only verifies; it does not sign, so this hand-rolls JWS compact
 * serialization for RS256, which is a handful of lines and avoids adding a
 * JWT-signing dependency this package's runtime code never needs.
 */
export interface TestSigningKey {
  readonly kid: string;
  readonly jwk: Jwk;
  readonly privateKey: KeyObject;
}

export function createTestSigningKey(kid = 'test-key-1'): TestSigningKey {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicJwk = publicKey.export({ format: 'jwk' }) as Jwk;

  return {
    kid,
    jwk: { ...publicJwk, kid, alg: 'RS256', use: 'sig' },
    privateKey,
  };
}

function base64url(input: Buffer): string {
  return input.toString('base64url');
}

export function signTestJwt(key: TestSigningKey, payload: Record<string, unknown>): string {
  const header = { alg: 'RS256', typ: 'JWT', kid: key.kid };
  const encodedHeader = base64url(Buffer.from(JSON.stringify(header)));
  const encodedPayload = base64url(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = cryptoSign('RSA-SHA256', Buffer.from(signingInput), key.privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

/** Flips one byte of the payload segment and re-encodes it, leaving the original signature in place. */
export function tamperPayload(jwt: string): string {
  const [header, payload, signature] = jwt.split('.');
  if (header === undefined || payload === undefined || signature === undefined) {
    throw new Error(`Not a compact JWS: "${jwt}"`);
  }
  const payloadBuf = Buffer.from(payload, 'base64url');
  payloadBuf[0] = (payloadBuf[0] ?? 0) ^ 0xff;
  return `${header}.${base64url(payloadBuf)}.${signature}`;
}
