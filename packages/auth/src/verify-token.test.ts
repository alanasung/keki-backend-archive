import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestSigningKey, signTestJwt, tamperPayload } from './test-support/rsa';

const BASE_ENV = {
  COGNITO_USER_POOL_ID: 'us-east-1_testPool01',
  COGNITO_CLIENT_ID: 'test-client-id',
  AWS_REGION: 'us-east-1',
  NODE_ENV: 'test',
};

/**
 * Loads a fresh `env`/`verify-token` module pair (so each test gets its own
 * JWKS cache), and pre-loads the cache with the given key via
 * `verifier.cacheJwks` so verification needs no network fetch.
 *
 * `InvalidTokenError` is imported here too, from the same post-resetModules
 * epoch as `verify-token` — a statically-imported class from file-load time
 * would be a distinct module instance after `vi.resetModules()`, breaking
 * `instanceof` checks below.
 */
async function loadVerifier(key: ReturnType<typeof createTestSigningKey>) {
  const { cognitoEnv } = await import('./env');
  const { verifier, verifyToken } = await import('./verify-token');
  const { InvalidTokenError } = await import('./errors');
  verifier.cacheJwks({ keys: [key.jwk] });
  return { cognitoEnv, verifyToken, InvalidTokenError };
}

function baseClaims(
  cognitoEnv: { issuer: string; clientId: string },
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: 'test-subject-1',
    iss: cognitoEnv.issuer,
    aud: cognitoEnv.clientId,
    token_use: 'id',
    email: 'person@example.com',
    iat: now,
    exp: now + 3600,
    ...overrides,
  };
}

describe('verifyToken', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv, ...BASE_ENV };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // Case 1
  it('verifies a validly signed token', async () => {
    const key = createTestSigningKey();
    const { cognitoEnv, verifyToken } = await loadVerifier(key);
    const token = signTestJwt(key, baseClaims(cognitoEnv));

    const result = await verifyToken(token);

    expect(result.sub).toBe('test-subject-1');
    expect(result.tokenUse).toBe('id');
    expect(result.email).toBe('person@example.com');
    expect(result.expiresAt).toBeInstanceOf(Date);
  });

  // Case 2
  it('rejects an expired token', async () => {
    const key = createTestSigningKey();
    const { cognitoEnv, verifyToken, InvalidTokenError } = await loadVerifier(key);
    const now = Math.floor(Date.now() / 1000);
    const token = signTestJwt(key, baseClaims(cognitoEnv, { iat: now - 7200, exp: now - 3600 }));

    await expect(verifyToken(token)).rejects.toThrow(InvalidTokenError);
  });

  // Case 3
  it('rejects a token with the wrong audience', async () => {
    const key = createTestSigningKey();
    const { cognitoEnv, verifyToken, InvalidTokenError } = await loadVerifier(key);
    const token = signTestJwt(key, baseClaims(cognitoEnv, { aud: 'some-other-client-id' }));

    await expect(verifyToken(token)).rejects.toThrow(InvalidTokenError);
  });

  // Case 4
  it('rejects a token with the wrong issuer', async () => {
    const key = createTestSigningKey();
    const { cognitoEnv, verifyToken, InvalidTokenError } = await loadVerifier(key);
    const token = signTestJwt(
      key,
      baseClaims(cognitoEnv, {
        iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_wrongPool0',
      }),
    );

    await expect(verifyToken(token)).rejects.toThrow(InvalidTokenError);
  });

  // Case 5
  it('rejects a token with a tampered signature', async () => {
    const key = createTestSigningKey();
    const { cognitoEnv, verifyToken, InvalidTokenError } = await loadVerifier(key);
    const token = signTestJwt(key, baseClaims(cognitoEnv));

    await expect(verifyToken(tamperPayload(token))).rejects.toThrow(InvalidTokenError);
  });
});
