import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomerProfile } from './session';
import { createTestSigningKey, signTestJwt } from './test-support/rsa';

const BASE_ENV = {
  COGNITO_USER_POOL_ID: 'us-east-1_testPool01',
  COGNITO_CLIENT_ID: 'test-client-id',
  AWS_REGION: 'us-east-1',
  NODE_ENV: 'test',
};

// Stubs the Postgres profile lookup so these tests exercise resolveSession's
// own logic without touching @keki/database (and its DATABASE_URL_* env
// requirement).
const mockFindProfileByCognitoSub = vi.fn<(cognitoSub: string) => Promise<CustomerProfile | null>>();

vi.mock('./profile', () => ({
  findProfileByCognitoSub: mockFindProfileByCognitoSub,
}));

async function loadResolveSession(key: ReturnType<typeof createTestSigningKey>) {
  const { cognitoEnv } = await import('./env');
  const { verifier } = await import('./verify-token');
  const { resolveSession } = await import('./session');
  verifier.cacheJwks({ keys: [key.jwk] });
  return { cognitoEnv, resolveSession };
}

function signedToken(
  key: ReturnType<typeof createTestSigningKey>,
  cognitoEnv: { issuer: string; clientId: string },
  overrides: Record<string, unknown> = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  return signTestJwt(key, {
    sub: 'cognito-sub-1',
    iss: cognitoEnv.issuer,
    aud: cognitoEnv.clientId,
    token_use: 'id',
    iat: now,
    exp: now + 3600,
    ...overrides,
  });
}

describe('resolveSession', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    mockFindProfileByCognitoSub.mockReset();
    process.env = { ...originalEnv, ...BASE_ENV };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // Case 7a
  it('resolves anonymous for a null token, without verifying or querying', async () => {
    const { resolveSession } = await loadResolveSession(createTestSigningKey());

    const result = await resolveSession(null);

    expect(result).toEqual({ kind: 'anonymous' });
    expect(mockFindProfileByCognitoSub).not.toHaveBeenCalled();
  });

  // Case 7
  it('resolves unprovisioned, not anonymous, when no profile row matches a valid token', async () => {
    const key = createTestSigningKey();
    const { cognitoEnv, resolveSession } = await loadResolveSession(key);
    mockFindProfileByCognitoSub.mockResolvedValue(null);
    const token = signedToken(key, cognitoEnv, { sub: 'cognito-sub-unprovisioned' });

    const result = await resolveSession(token);

    expect(result).toEqual({ kind: 'unprovisioned', cognitoSub: 'cognito-sub-unprovisioned' });
  });

  // Case 6
  it('ignores cognito:groups and uses the Postgres role for an authenticated session', async () => {
    const key = createTestSigningKey();
    const { cognitoEnv, resolveSession } = await loadResolveSession(key);
    mockFindProfileByCognitoSub.mockResolvedValue({
      customerId: 'customer-1',
      householdId: null,
      email: 'person@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
      role: 'CUSTOMER',
    } as unknown as CustomerProfile);
    const token = signedToken(key, cognitoEnv, {
      sub: 'cognito-sub-admin-claim',
      'cognito:groups': ['ADMIN'],
    });

    const result = await resolveSession(token);

    expect(result.kind).toBe('authenticated');
    if (result.kind === 'authenticated') {
      expect(result.session.profile.role).toBe('CUSTOMER');
      expect(result.session.cognitoSub).toBe('cognito-sub-admin-claim');
    }
  });
});
