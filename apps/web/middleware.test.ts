import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ID_TOKEN_COOKIE_NAME,
  OAUTH_STATE_COOKIE_NAME,
  OAUTH_VERIFIER_COOKIE_NAME,
  REFRESH_TOKEN_COOKIE_NAME,
  REFRESHED_ID_TOKEN_HEADER,
} from './app/auth/session-cookies';

const { mockRefreshSession, mockShouldRefresh } = vi.hoisted(() => ({
  mockRefreshSession: vi.fn(),
  mockShouldRefresh: vi.fn(),
}));

// Only `refreshSession`/`shouldRefresh` are mocked; `extractToken` (also
// imported from a `@keki/auth` subpath by middleware.ts) is pure string
// parsing with no dependency on a Node/database runtime, so the real
// implementation runs here same as in production.
vi.mock('@keki/auth/oauth', () => ({
  refreshSession: mockRefreshSession,
  shouldRefresh: mockShouldRefresh,
}));

const { config, middleware } = await import('./middleware');

const dir = dirname(fileURLToPath(import.meta.url));

function requestFor(path: string, options: { readonly cookie?: string } = {}): NextRequest {
  const headers = options.cookie !== undefined ? { cookie: options.cookie } : {};
  return new NextRequest(new URL(path, 'http://localhost:3000'), { headers });
}

/** A JWT-shaped (unsigned) token carrying only the `exp` claim `decodeIdTokenExpiry` reads. */
function fakeIdToken(exp: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  return `${header}.${payload}.signature`;
}

describe('middleware', () => {
  beforeEach(() => {
    mockRefreshSession.mockReset();
    mockShouldRefresh.mockReset().mockReturnValue(false);
  });

  // Case 11
  it('sets x-pathname on the forwarded request for a matched path', async () => {
    const response = await middleware(requestFor('/staff/today', { cookie: 'keki_id_token=valid-token' }));

    expect(response.headers.get('x-middleware-request-x-pathname')).toBe('/staff/today');
    expect(response.headers.get('location')).toBeNull();
  });

  // Case 12
  it('redirects a cookieless /staff request to sign-in', async () => {
    const response = await middleware(requestFor('/staff/today'));

    expect(response.status).toBe(307);
    const location = response.headers.get('location');
    expect(location).not.toBeNull();
    const redirectUrl = new URL(location ?? '');
    expect(redirectUrl.pathname).toBe('/auth/sign-in');
    expect(redirectUrl.searchParams.get('next')).toBe('/staff/today');
  });

  it('redirects a cookieless /admin request to sign-in', async () => {
    const response = await middleware(requestFor('/admin/offerings'));

    expect(response.status).toBe(307);
    const redirectUrl = new URL(response.headers.get('location') ?? '');
    expect(redirectUrl.pathname).toBe('/auth/sign-in');
    expect(redirectUrl.searchParams.get('next')).toBe('/admin/offerings');
  });

  // Case 13
  it('does not gate the public customer surface', async () => {
    const response = await middleware(requestFor('/book'));

    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('x-middleware-request-x-pathname')).toBe('/book');
  });

  it('does not gate the sign-in page itself, avoiding a redirect loop', async () => {
    const response = await middleware(requestFor('/auth/sign-in'));

    expect(response.headers.get('location')).toBeNull();
  });

  // Case 14
  it('imports no database or domain-core package (Edge runtime cannot reach Postgres)', () => {
    const source = readFileSync(join(dir, 'middleware.ts'), 'utf-8');
    expect(source).not.toMatch(/from\s+['"]@keki\/database['"]/);
    expect(source).not.toMatch(/from\s+['"]@keki\/[\w-]*-core['"]/);
  });

  it('the matcher excludes _next, static assets, and /auth', () => {
    expect(config.matcher).toEqual(
      expect.arrayContaining([expect.stringContaining('_next')]),
    );
    for (const pattern of config.matcher) {
      expect(pattern).toContain('auth');
    }
  });

  describe('near-expiry refresh', () => {
    // Test 22 — SC-06
    it('refreshes a near-expired session and forwards the new id token', async () => {
      mockShouldRefresh.mockReturnValue(true);
      mockRefreshSession.mockResolvedValue({
        id_token: 'new-id-token',
        access_token: 'new-access-token',
        expires_in: 3600,
        token_type: 'Bearer',
      });
      const cookie = `keki_id_token=${fakeIdToken(1)}; keki_refresh_token=refresh-value-1`;

      const response = await middleware(requestFor('/book', { cookie }));

      expect(mockRefreshSession).toHaveBeenCalledWith({ refreshToken: 'refresh-value-1' });
      expect(response.cookies.get(ID_TOKEN_COOKIE_NAME)?.value).toBe('new-id-token');
      expect(response.headers.get(`x-middleware-request-${REFRESHED_ID_TOKEN_HEADER}`)).toBe('new-id-token');
    });

    // Test 23 — the discriminating half of test 22
    it('does not refresh a session that is far from expiry', async () => {
      mockShouldRefresh.mockReturnValue(false);
      const farFromExpiry = Math.floor(Date.now() / 1000) + 60 * 60;
      const cookie = `keki_id_token=${fakeIdToken(farFromExpiry)}; keki_refresh_token=refresh-value-1`;

      const response = await middleware(requestFor('/book', { cookie }));

      expect(mockRefreshSession).not.toHaveBeenCalled();
      expect(response.cookies.get(ID_TOKEN_COOKIE_NAME)).toBeUndefined();
      expect(response.headers.get(`x-middleware-request-${REFRESHED_ID_TOKEN_HEADER}`)).toBeNull();
    });

    // Test 24
    it('clears the session rather than retrying when refresh fails', async () => {
      mockShouldRefresh.mockReturnValue(true);
      mockRefreshSession.mockRejectedValue(new Error('refresh token rejected'));
      const cookie = `keki_id_token=${fakeIdToken(1)}; keki_refresh_token=refresh-value-1`;

      const response = await middleware(requestFor('/book', { cookie }));

      for (const name of [ID_TOKEN_COOKIE_NAME, REFRESH_TOKEN_COOKIE_NAME, OAUTH_STATE_COOKIE_NAME, OAUTH_VERIFIER_COOKIE_NAME]) {
        const responseCookie = response.cookies.get(name);
        expect(responseCookie?.value).toBe('');
        expect((responseCookie as { maxAge?: number } | undefined)?.maxAge).toBeLessThanOrEqual(0);
      }
    });
  });
});
