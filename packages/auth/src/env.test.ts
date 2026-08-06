import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const VALID_ENV = {
  COGNITO_USER_POOL_ID: 'us-east-1_testPool01',
  COGNITO_CLIENT_ID: 'test-client-id',
  AWS_REGION: 'us-east-1',
};

describe('env', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // Case 13
  it('throws AuthConfigError naming the missing variable when config is absent', async () => {
    process.env = { ...VALID_ENV, NODE_ENV: 'test' };
    delete (process.env as Record<string, string | undefined>).COGNITO_USER_POOL_ID;

    // Imported fresh in the same epoch as `./env` below (after
    // vi.resetModules()), so the thrown error's class matches this reference
    // — a statically-imported class from module load time would be a
    // different module instance after resetModules clears the registry.
    const { AuthConfigError } = await import('./errors');

    let error: unknown;
    try {
      await import('./env');
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AuthConfigError);
    expect((error as Error).message).toContain('COGNITO_USER_POOL_ID');
  });

  // Case 14
  it('applies COGNITO_ISSUER and COGNITO_JWKS_URI overrides outside production', async () => {
    process.env = {
      ...VALID_ENV,
      NODE_ENV: 'test',
      COGNITO_ISSUER: 'https://local.test/issuer',
      COGNITO_JWKS_URI: 'https://local.test/.well-known/jwks.json',
    };

    const { cognitoEnv } = await import('./env');

    expect(cognitoEnv.issuer).toBe('https://local.test/issuer');
    expect(cognitoEnv.jwksUri).toBe('https://local.test/.well-known/jwks.json');
  });

  // Case 15
  it('refuses COGNITO_ISSUER / COGNITO_JWKS_URI overrides when NODE_ENV=production', async () => {
    process.env = {
      ...VALID_ENV,
      NODE_ENV: 'production',
      COGNITO_ISSUER: 'https://local.test/issuer',
    };

    const { AuthConfigError } = await import('./errors');

    let error: unknown;
    try {
      await import('./env');
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AuthConfigError);
  });

  it('refuses a COGNITO_JWKS_URI-only override when NODE_ENV=production', async () => {
    process.env = {
      ...VALID_ENV,
      NODE_ENV: 'production',
      COGNITO_JWKS_URI: 'https://local.test/.well-known/jwks.json',
    };

    const { AuthConfigError } = await import('./errors');

    let error: unknown;
    try {
      await import('./env');
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AuthConfigError);
  });

  it('derives issuer and JWKS URI from the pool id and region when no override is set', async () => {
    process.env = { ...VALID_ENV, NODE_ENV: 'production' };

    const { cognitoEnv } = await import('./env');

    expect(cognitoEnv.issuer).toBe('https://cognito-idp.us-east-1.amazonaws.com/us-east-1_testPool01');
    expect(cognitoEnv.jwksUri).toBe(
      'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_testPool01/.well-known/jwks.json',
    );
  });
});
