import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const VALID_ENV = {
  COGNITO_HOSTED_UI_URL: 'https://keki-test.auth.us-east-1.amazoncognito.com',
  COGNITO_REDIRECT_URI: 'https://app.keki.test/auth/callback',
  COGNITO_SIGN_OUT_URI: 'https://app.keki.test/auth/sign-out/complete',
};

describe('oauth-env', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('resolves hostedUiUrl, redirectUri, and signOutUri from the environment', async () => {
    process.env = { ...VALID_ENV, NODE_ENV: 'test' };

    const { cognitoOAuthEnv } = await import('./oauth-env');

    expect(cognitoOAuthEnv.hostedUiUrl).toBe(VALID_ENV.COGNITO_HOSTED_UI_URL);
    expect(cognitoOAuthEnv.redirectUri).toBe(VALID_ENV.COGNITO_REDIRECT_URI);
    expect(cognitoOAuthEnv.signOutUri).toBe(VALID_ENV.COGNITO_SIGN_OUT_URI);
  });

  // Test 27
  it('names the missing variable when COGNITO_HOSTED_UI_URL is absent', async () => {
    process.env = { ...VALID_ENV, NODE_ENV: 'test' };
    delete (process.env as Record<string, string | undefined>).COGNITO_HOSTED_UI_URL;

    const { AuthConfigError } = await import('./errors');

    let error: unknown;
    try {
      await import('./oauth-env');
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AuthConfigError);
    expect((error as Error).message).toContain('COGNITO_HOSTED_UI_URL');
  });

  it('names the missing variable when COGNITO_REDIRECT_URI is absent', async () => {
    process.env = { ...VALID_ENV, NODE_ENV: 'test' };
    delete (process.env as Record<string, string | undefined>).COGNITO_REDIRECT_URI;

    const { AuthConfigError } = await import('./errors');

    let error: unknown;
    try {
      await import('./oauth-env');
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AuthConfigError);
    expect((error as Error).message).toContain('COGNITO_REDIRECT_URI');
  });

  it('names the missing variable when COGNITO_SIGN_OUT_URI is absent', async () => {
    process.env = { ...VALID_ENV, NODE_ENV: 'test' };
    delete (process.env as Record<string, string | undefined>).COGNITO_SIGN_OUT_URI;

    const { AuthConfigError } = await import('./errors');

    let error: unknown;
    try {
      await import('./oauth-env');
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AuthConfigError);
    expect((error as Error).message).toContain('COGNITO_SIGN_OUT_URI');
  });

  // Test 25
  it('rejects a non-https redirect URI in production', async () => {
    process.env = {
      ...VALID_ENV,
      NODE_ENV: 'production',
      COGNITO_REDIRECT_URI: 'http://app.keki.test/auth/callback',
    };

    const { AuthConfigError } = await import('./errors');

    let error: unknown;
    try {
      await import('./oauth-env');
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AuthConfigError);
    expect((error as Error).message).toContain('COGNITO_REDIRECT_URI');
  });

  it('rejects a non-https hosted UI URL in production', async () => {
    process.env = {
      ...VALID_ENV,
      NODE_ENV: 'production',
      COGNITO_HOSTED_UI_URL: 'http://keki-test.auth.us-east-1.amazoncognito.com',
    };

    const { AuthConfigError } = await import('./errors');

    let error: unknown;
    try {
      await import('./oauth-env');
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AuthConfigError);
  });

  it('rejects a non-https sign-out URI in production', async () => {
    process.env = {
      ...VALID_ENV,
      NODE_ENV: 'production',
      COGNITO_SIGN_OUT_URI: 'http://app.keki.test/auth/sign-out/complete',
    };

    const { AuthConfigError } = await import('./errors');

    let error: unknown;
    try {
      await import('./oauth-env');
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AuthConfigError);
  });

  // Test 26
  it('permits http://localhost outside production', async () => {
    process.env = {
      ...VALID_ENV,
      NODE_ENV: 'development',
      COGNITO_REDIRECT_URI: 'http://localhost:3000/auth/callback',
    };

    const { cognitoOAuthEnv } = await import('./oauth-env');

    expect(cognitoOAuthEnv.redirectUri).toBe('http://localhost:3000/auth/callback');
  });

  it('permits https URLs in production', async () => {
    process.env = { ...VALID_ENV, NODE_ENV: 'production' };

    const { cognitoOAuthEnv } = await import('./oauth-env');

    expect(cognitoOAuthEnv.hostedUiUrl).toBe(VALID_ENV.COGNITO_HOSTED_UI_URL);
  });
});
