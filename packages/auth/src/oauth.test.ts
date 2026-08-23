import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

describe('oauth', () => {
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
      const { createPkcePair } = await import('./oauth');

      const { verifier } = createPkcePair();

      expect(verifier).not.toMatch(/[+/=]/);
      expect(verifier.length).toBeGreaterThanOrEqual(43);
    });

    // Test 2
    it('derives the challenge as the SHA-256 of the verifier, base64url', async () => {
      const { createPkcePair } = await import('./oauth');

      const { verifier, challenge } = createPkcePair();

      expect(challenge).toBe(sha256Base64Url(verifier));
      expect(challenge).not.toBe(verifier);
    });

    // Test 3
    it('produces a different verifier on every call', async () => {
      const { createPkcePair } = await import('./oauth');

      const verifiers = Array.from({ length: 10 }, () => createPkcePair().verifier);

      expect(new Set(verifiers).size).toBe(10);
    });
  });

  describe('buildAuthorizationUrl', () => {
    // Test 4
    it('sets response_type=code and never implicit', async () => {
      const { buildAuthorizationUrl } = await import('./oauth');

      const { url } = buildAuthorizationUrl();
      const params = new URL(url).searchParams;

      expect(params.get('response_type')).toBe('code');
      expect(url).not.toContain('implicit');
    });

    // Test 5
    it('sets code_challenge_method=S256', async () => {
      const { buildAuthorizationUrl } = await import('./oauth');

      const { url } = buildAuthorizationUrl();

      expect(new URL(url).searchParams.get('code_challenge_method')).toBe('S256');
    });

    // Test 6
    it('carries the configured client_id and redirect_uri', async () => {
      const { buildAuthorizationUrl } = await import('./oauth');

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
      const { buildAuthorizationUrl } = await import('./oauth');

      const unsafeBuild = buildAuthorizationUrl as unknown as (input?: Record<string, unknown>) => {
        url: string;
      };
      const { url } = unsafeBuild({ redirectUri: 'https://evil.example.com/callback' });

      expect(new URL(url).searchParams.get('redirect_uri')).toBe(BASE_ENV.COGNITO_REDIRECT_URI);
    });

    // Test 8
    it('requests openid email profile', async () => {
      const { buildAuthorizationUrl } = await import('./oauth');

      const { url } = buildAuthorizationUrl();

      expect(new URL(url).searchParams.get('scope')).toBe('openid email profile');
    });

    // Test 9
    it('returns a state and verifier matching what the URL embeds', async () => {
      const { buildAuthorizationUrl } = await import('./oauth');

      const { url, state, verifier } = buildAuthorizationUrl();
      const params = new URL(url).searchParams;

      expect(params.get('state')).toBe(state);
      expect(params.get('code_challenge')).toBe(sha256Base64Url(verifier));
    });

    // Test 10
    it('produces a different state on every call', async () => {
      const { buildAuthorizationUrl } = await import('./oauth');

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
      const { buildAuthorizationUrl } = await import('./oauth');

      const { url } = buildAuthorizationUrl();

      expect(url).not.toContain('callback?next=/dashboard');
      expect(new URL(url).searchParams.get('redirect_uri')).toBe(
        'https://app.keki.test/auth/callback?next=/dashboard',
      );
    });
  });

  describe('exchangeCodeForTokens', () => {
    const validTokenResponse = {
      id_token: 'id-token-value',
      access_token: 'access-token-value',
      refresh_token: 'refresh-token-value',
      expires_in: 3600,
      token_type: 'Bearer',
    };

    // Tests 12 and 13
    it('posts form-encoded with grant type, code, verifier, and redirect URI', async () => {
      const fetchImpl = vi.fn(() => Promise.resolve(new Response(JSON.stringify(validTokenResponse), { status: 200 })));
      const { exchangeCodeForTokens } = await import('./oauth');

      await exchangeCodeForTokens({ code: 'auth-code-1', verifier: 'verifier-1', fetchImpl });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [calledUrl, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      expect(calledUrl).toBe(`${BASE_ENV.COGNITO_HOSTED_UI_URL}/oauth2/token`);
      expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded');

      const body = new URLSearchParams(init.body as string);
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('client_id')).toBe(BASE_ENV.COGNITO_CLIENT_ID);
      expect(body.get('code')).toBe('auth-code-1');
      expect(body.get('redirect_uri')).toBe(BASE_ENV.COGNITO_REDIRECT_URI);
      expect(body.get('code_verifier')).toBe('verifier-1');
    });

    // Test 14
    it('returns the parsed token response', async () => {
      const fetchImpl = vi.fn(() => Promise.resolve(new Response(JSON.stringify(validTokenResponse), { status: 200 })));
      const { exchangeCodeForTokens } = await import('./oauth');

      const result = await exchangeCodeForTokens({ code: 'auth-code-1', verifier: 'verifier-1', fetchImpl });

      expect(result.id_token).toBe('id-token-value');
    });

    // Test 15
    it('throws OAuthExchangeError carrying the status on a non-2xx response', async () => {
      const fetchImpl = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })));
      const { exchangeCodeForTokens } = await import('./oauth');
      const { OAuthExchangeError } = await import('./errors');

      let error: unknown;
      try {
        await exchangeCodeForTokens({ code: 'auth-code-1', verifier: 'verifier-1', fetchImpl });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(OAuthExchangeError);
      expect((error as InstanceType<typeof OAuthExchangeError>).status).toBe(400);
    });

    // Test 16
    it('does not echo the response body into the error message', async () => {
      const fetchImpl = vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ error: 'invalid_grant', code: 'auth-code-1' }), { status: 400 })),
      );
      const { exchangeCodeForTokens } = await import('./oauth');

      let error: unknown;
      try {
        await exchangeCodeForTokens({ code: 'auth-code-1', verifier: 'verifier-1', fetchImpl });
      } catch (caught) {
        error = caught;
      }

      expect((error as Error).message).not.toContain('auth-code-1');
    });

    // Test 17
    it('throws when the response body is malformed', async () => {
      const fetchImpl = vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ access_token: 'a', expires_in: 3600, token_type: 'Bearer' }), {
            status: 200,
          }),
        ),
      );
      const { exchangeCodeForTokens } = await import('./oauth');

      await expect(exchangeCodeForTokens({ code: 'auth-code-1', verifier: 'verifier-1', fetchImpl })).rejects.toThrow();
    });
  });

  describe('refreshSession', () => {
    const validRefreshResponse = {
      id_token: 'new-id-token',
      access_token: 'new-access-token',
      expires_in: 3600,
      token_type: 'Bearer',
    };

    // Test 18
    it('uses grant_type=refresh_token and sends no code_verifier', async () => {
      const fetchImpl = vi.fn(() => Promise.resolve(new Response(JSON.stringify(validRefreshResponse), { status: 200 })));
      const { refreshSession } = await import('./oauth');

      await refreshSession({ refreshToken: 'refresh-token-1', fetchImpl });

      const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      const body = new URLSearchParams(init.body as string);

      expect(body.get('grant_type')).toBe('refresh_token');
      expect(body.get('refresh_token')).toBe('refresh-token-1');
      expect(body.has('code_verifier')).toBe(false);
    });

    // Test 19
    it('succeeds when the response omits refresh_token', async () => {
      const fetchImpl = vi.fn(() => Promise.resolve(new Response(JSON.stringify(validRefreshResponse), { status: 200 })));
      const { refreshSession } = await import('./oauth');

      const result = await refreshSession({ refreshToken: 'refresh-token-1', fetchImpl });

      expect(result.id_token).toBe('new-id-token');
      expect(result.refresh_token).toBeUndefined();
    });

    // Test 20
    it('throws OAuthRefreshError on a failed refresh', async () => {
      const fetchImpl = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })));
      const { refreshSession } = await import('./oauth');
      const { OAuthRefreshError } = await import('./errors');

      let error: unknown;
      try {
        await refreshSession({ refreshToken: 'refresh-token-1', fetchImpl });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(OAuthRefreshError);
      expect((error as InstanceType<typeof OAuthRefreshError>).status).toBe(400);
    });
  });

  describe('buildSignOutUrl', () => {
    // Test 21
    it('carries the client id and logout URI', async () => {
      const { buildSignOutUrl } = await import('./oauth');

      const url = new URL(buildSignOutUrl());

      expect(url.origin + url.pathname).toBe(`${BASE_ENV.COGNITO_HOSTED_UI_URL}/logout`);
      expect(url.searchParams.get('client_id')).toBe(BASE_ENV.COGNITO_CLIENT_ID);
      expect(url.searchParams.get('logout_uri')).toBe(BASE_ENV.COGNITO_SIGN_OUT_URI);
    });
  });

  describe('shouldRefresh', () => {
    const now = new Date('2026-08-23T12:00:00Z');

    // Test 22
    it('is true inside the skew window', async () => {
      const { shouldRefresh } = await import('./oauth');
      const expiresAt = new Date(now.getTime() + 60_000);

      expect(shouldRefresh(expiresAt, now, 120)).toBe(true);
    });

    // Test 23
    it('is false outside the skew window', async () => {
      const { shouldRefresh } = await import('./oauth');
      const expiresAt = new Date(now.getTime() + 10 * 60_000);

      expect(shouldRefresh(expiresAt, now, 120)).toBe(false);
    });

    // Test 24
    it('is true for an already-expired token', async () => {
      const { shouldRefresh } = await import('./oauth');
      const expiresAt = new Date(now.getTime() - 60_000);

      expect(shouldRefresh(expiresAt, now, 120)).toBe(true);
    });
  });

  // Test 28
  it('imports nothing from Next.js anywhere under packages/auth/src', () => {
    const srcDir = fileURLToPath(new URL('.', import.meta.url));
    const files = readdirSync(srcDir, { recursive: true, withFileTypes: true }).filter(
      (entry) => entry.isFile() && /\.tsx?$/.test(entry.name),
    );

    for (const file of files) {
      const source = readFileSync(join(file.parentPath, file.name), 'utf-8');
      expect(source).not.toMatch(/from ['"]next(\/|['"])/);
      expect(source).not.toMatch(/require\(['"]next(\/|['"])/);
    }
  });
});
