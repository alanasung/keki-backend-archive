import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OAUTH_NEXT_COOKIE_NAME, OAUTH_STATE_COOKIE_NAME, OAUTH_VERIFIER_COOKIE_NAME } from '../session-cookies';

const AUTHORIZATION_REQUEST = {
  url: 'https://keki-test.auth.us-east-1.amazoncognito.com/oauth2/authorize?state=state-1',
  state: 'state-1',
  verifier: 'verifier-1',
};

const { mockBuildAuthorizationUrl } = vi.hoisted(() => ({
  mockBuildAuthorizationUrl: vi.fn(() => AUTHORIZATION_REQUEST),
}));

vi.mock('@keki/auth', () => ({
  buildAuthorizationUrl: mockBuildAuthorizationUrl,
}));

const { mockCookiesSet } = vi.hoisted(() => ({
  mockCookiesSet: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(() => Promise.resolve({ set: mockCookiesSet })),
}));

const { GET } = await import('./route');

function requestFor(query: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/auth/sign-in');
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return new NextRequest(url);
}

function cookieCall(name: string): [string, string, Record<string, unknown>] | undefined {
  return mockCookiesSet.mock.calls.find((call) => call[0] === name) as
    | [string, string, Record<string, unknown>]
    | undefined;
}

describe('/auth/sign-in', () => {
  beforeEach(() => {
    mockCookiesSet.mockReset();
    mockBuildAuthorizationUrl.mockClear();
  });

  // Test 1 — SC-01
  it('redirects to the authorization URL buildAuthorizationUrl returned', async () => {
    const response = await GET(requestFor());

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(AUTHORIZATION_REQUEST.url);
  });

  // Test 2 — SC-02
  it('sets the state and verifier cookies, httpOnly, carrying the returned values', async () => {
    await GET(requestFor());

    const stateCall = cookieCall(OAUTH_STATE_COOKIE_NAME);
    const verifierCall = cookieCall(OAUTH_VERIFIER_COOKIE_NAME);

    expect(stateCall?.[1]).toBe(AUTHORIZATION_REQUEST.state);
    expect(stateCall?.[2]?.['httpOnly']).toBe(true);
    expect(verifierCall?.[1]).toBe(AUTHORIZATION_REQUEST.verifier);
    expect(verifierCall?.[2]?.['httpOnly']).toBe(true);
  });

  // Test 3
  it('sets those cookies SameSite=Lax, not Strict', async () => {
    await GET(requestFor());

    expect(cookieCall(OAUTH_STATE_COOKIE_NAME)?.[2]?.['sameSite']).toBe('lax');
    expect(cookieCall(OAUTH_VERIFIER_COOKIE_NAME)?.[2]?.['sameSite']).toBe('lax');
  });

  // Test 4
  describe('Secure attribute', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('is set in production', async () => {
      vi.stubEnv('NODE_ENV', 'production');

      await GET(requestFor());

      expect(cookieCall(OAUTH_STATE_COOKIE_NAME)?.[2]?.['secure']).toBe(true);
    });

    it('is absent otherwise, so localhost works', async () => {
      vi.stubEnv('NODE_ENV', 'test');

      await GET(requestFor());

      expect(cookieCall(OAUTH_STATE_COOKIE_NAME)?.[2]?.['secure']).toBe(false);
    });
  });

  // Test 5
  it('sanitizes next before storing it', async () => {
    await GET(requestFor({ next: 'https://evil.example/x' }));

    expect(cookieCall(OAUTH_NEXT_COOKIE_NAME)?.[1]).toBe('/');
  });

  it('stores a legitimate relative next unchanged', async () => {
    await GET(requestFor({ next: '/account' }));

    expect(cookieCall(OAUTH_NEXT_COOKIE_NAME)?.[1]).toBe('/account');
  });

  // Test 6
  it('defaults to a local path when next is missing', async () => {
    await GET(requestFor());

    expect(cookieCall(OAUTH_NEXT_COOKIE_NAME)?.[1]).toBe('/');
  });
});
