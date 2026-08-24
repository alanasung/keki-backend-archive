import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const BASE_ENV = {
  COGNITO_USER_POOL_ID: 'us-east-1_testPool01',
  COGNITO_CLIENT_ID: 'test-client-id',
  AWS_REGION: 'us-east-1',
  COGNITO_HOSTED_UI_URL: 'https://keki-test.auth.us-east-1.amazoncognito.com',
  COGNITO_REDIRECT_URI: 'https://app.keki.test/auth/callback',
  COGNITO_SIGN_OUT_URI: 'https://app.keki.test/auth/sign-out/complete',
  NODE_ENV: 'test',
};

function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

describe('pkce', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...BASE_ENV };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('createPkcePair', () => {
    // Test 1
    it('produces a base64url verifier at least 43 characters long', async () => {
      const { createPkcePair } = await import('./pkce');

      const { verifier } = createPkcePair();

      expect(verifier).not.toMatch(/[+/=]/);
      expect(verifier.length).toBeGreaterThanOrEqual(43);
    });

    // Test 2
    it('derives the challenge as the SHA-256 of the verifier, base64url', async () => {
      const { createPkcePair } = await import('./pkce');

      const { verifier, challenge } = createPkcePair();

      expect(challenge).toBe(sha256Base64Url(verifier));
      expect(challenge).not.toBe(verifier);
    });

    // Test 3
    it('produces a different verifier on every call', async () => {
      const { createPkcePair } = await import('./pkce');

      const verifiers = Array.from({ length: 10 }, () => createPkcePair().verifier);

      expect(new Set(verifiers).size).toBe(10);
    });
  });

  describe('buildAuthorizationUrl', () => {
    // Test 4
    it('sets response_type=code and never implicit', async () => {
      const { buildAuthorizationUrl } = await import('./pkce');

      const { url } = buildAuthorizationUrl();
      const params = new URL(url).searchParams;

      expect(params.get('response_type')).toBe('code');
      expect(url).not.toContain('implicit');
    });

    // Test 5
    it('sets code_challenge_method=S256', async () => {
      const { buildAuthorizationUrl } = await import('./pkce');

      const { url } = buildAuthorizationUrl();

      expect(new URL(url).searchParams.get('code_challenge_method')).toBe('S256');
    });

    // Test 6
    it('carries the configured client_id and redirect_uri', async () => {
      const { buildAuthorizationUrl } = await import('./pkce');

      const { url } = buildAuthorizationUrl();
      const params = new URL(url).searchParams;

      expect(params.get('client_id')).toBe(BASE_ENV.COGNITO_CLIENT_ID);
      expect(params.get('redirect_uri')).toBe(BASE_ENV.COGNITO_REDIRECT_URI);
    });

    // Test 7 — the function's type signature makes a caller-supplied
    // redirect_uri unrepresentable at compile time (no such parameter
    // exists). This exercises the runtime backstop: even a caller that
    // bypasses the type system by casting cannot influence the value sent.
    it('ignores an attempted caller-supplied redirect_uri', async () => {
      const { buildAuthorizationUrl } = await import('./pkce');

      const unsafeBuild = buildAuthorizationUrl as unknown as (input?: Record<string, unknown>) => {
        url: string;
      };
      const { url } = unsafeBuild({ redirectUri: 'https://evil.example.com/callback' });

      expect(new URL(url).searchParams.get('redirect_uri')).toBe(BASE_ENV.COGNITO_REDIRECT_URI);
    });

    // Test 8
    it('requests openid email profile', async () => {
      const { buildAuthorizationUrl } = await import('./pkce');

      const { url } = buildAuthorizationUrl();

      expect(new URL(url).searchParams.get('scope')).toBe('openid email profile');
    });

    // Test 9
    it('returns a state and verifier matching what the URL embeds', async () => {
      const { buildAuthorizationUrl } = await import('./pkce');

      const { url, state, verifier } = buildAuthorizationUrl();
      const params = new URL(url).searchParams;

      expect(params.get('state')).toBe(state);
      expect(params.get('code_challenge')).toBe(sha256Base64Url(verifier));
    });

    // Test 10
    it('produces a different state on every call', async () => {
      const { buildAuthorizationUrl } = await import('./pkce');

      const first = buildAuthorizationUrl();
      const second = buildAuthorizationUrl();

      expect(first.state).not.toBe(second.state);
    });

    // Test 11
    it('URL-encodes parameters, including a redirect URI containing a query string', async () => {
      vi.resetModules();
      process.env = {
        ...BASE_ENV,
        COGNITO_REDIRECT_URI: 'https://app.keki.test/auth/callback?next=/dashboard',
      };
      const { buildAuthorizationUrl } = await import('./pkce');

      const { url } = buildAuthorizationUrl();

      expect(url).not.toContain('callback?next=/dashboard');
      expect(new URL(url).searchParams.get('redirect_uri')).toBe(
        'https://app.keki.test/auth/callback?next=/dashboard',
      );
    });
  });
});
