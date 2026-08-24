import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ID_TOKEN_COOKIE_NAME, OAUTH_NEXT_COOKIE_NAME, OAUTH_STATE_COOKIE_NAME, OAUTH_VERIFIER_COOKIE_NAME, REFRESH_TOKEN_COOKIE_NAME } from '../session-cookies';

const { mockExchangeCodeForTokens, OAuthExchangeError } = vi.hoisted(() => {
  class OAuthExchangeError extends Error {}
  return { mockExchangeCodeForTokens: vi.fn(), OAuthExchangeError };
});

vi.mock('@keki/auth', () => ({
  exchangeCodeForTokens: mockExchangeCodeForTokens,
  OAuthExchangeError,
}));

const { mockCookiesGet, mockCookiesSet } = vi.hoisted(() => ({
  mockCookiesGet: vi.fn(),
  mockCookiesSet: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(() => Promise.resolve({ get: mockCookiesGet, set: mockCookiesSet })),
}));

const { GET } = await import('./route');

const BASE_URL = 'http://localhost:3000/auth/callback';
const VALID_TOKENS = {
  id_token: 'new-id-token',
  access_token: 'new-access-token',
  refresh_token: 'new-refresh-token',
  expires_in: 3600,
  token_type: 'Bearer',
};

function requestFor(query: Record<string, string>): NextRequest {
  const url = new URL(BASE_URL);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return new NextRequest(url);
}

function setCookies(map: Record<string, string>): void {
  mockCookiesGet.mockImplementation((name: string) =>
    map[name] !== undefined ? { name, value: map[name] } : undefined,
  );
}

function setCalledFor(name: string): unknown[][] {
  return mockCookiesSet.mock.calls.filter((call) => call[0] === name);
}

describe('/auth/callback', () => {
  beforeEach(() => {
    mockExchangeCodeForTokens.mockReset();
    mockCookiesGet.mockReset();
    mockCookiesSet.mockReset();
    setCookies({});
  });

  // Test 18
  it('redirects to sign-in on a Cognito error parameter instead of crashing', async () => {
    const response = await GET(requestFor({ error: 'access_denied' }));

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get('location') ?? '').pathname).toBe('/auth/sign-in');
    expect(mockExchangeCodeForTokens).not.toHaveBeenCalled();
  });

  it('redirects to sign-in when code is missing entirely', async () => {
    const response = await GET(requestFor({}));

    expect(new URL(response.headers.get('location') ?? '').pathname).toBe('/auth/sign-in');
    expect(mockExchangeCodeForTokens).not.toHaveBeenCalled();
  });

  // Test 7
  it('rejects a mismatched state before any exchange', async () => {
    setCookies({ [OAUTH_STATE_COOKIE_NAME]: 'A', [OAUTH_VERIFIER_COOKIE_NAME]: 'verifier-1' });

    const response = await GET(requestFor({ code: 'auth-code', state: 'B' }));

    expect(new URL(response.headers.get('location') ?? '').pathname).toBe('/auth/sign-in');
    expect(mockExchangeCodeForTokens).not.toHaveBeenCalled();
  });

  // Test 8
  it('rejects a missing state cookie before any exchange', async () => {
    setCookies({ [OAUTH_VERIFIER_COOKIE_NAME]: 'verifier-1' });

    const response = await GET(requestFor({ code: 'auth-code', state: 'B' }));

    expect(new URL(response.headers.get('location') ?? '').pathname).toBe('/auth/sign-in');
    expect(mockExchangeCodeForTokens).not.toHaveBeenCalled();
  });

  // Test 9
  it('rejects a missing verifier cookie before any exchange', async () => {
    setCookies({ [OAUTH_STATE_COOKIE_NAME]: 'state-1' });

    const response = await GET(requestFor({ code: 'auth-code', state: 'state-1' }));

    expect(new URL(response.headers.get('location') ?? '').pathname).toBe('/auth/sign-in');
    expect(mockExchangeCodeForTokens).not.toHaveBeenCalled();
  });

  // Test 10
  it('proceeds to exchange when state matches, using the query code and cookie verifier', async () => {
    setCookies({ [OAUTH_STATE_COOKIE_NAME]: 'state-1', [OAUTH_VERIFIER_COOKIE_NAME]: 'verifier-1' });
    mockExchangeCodeForTokens.mockResolvedValue(VALID_TOKENS);

    await GET(requestFor({ code: 'auth-code-1', state: 'state-1' }));

    expect(mockExchangeCodeForTokens).toHaveBeenCalledWith({ code: 'auth-code-1', verifier: 'verifier-1' });
  });

  describe('after a successful exchange', () => {
    beforeEach(() => {
      setCookies({
        [OAUTH_STATE_COOKIE_NAME]: 'state-1',
        [OAUTH_VERIFIER_COOKIE_NAME]: 'verifier-1',
        [OAUTH_NEXT_COOKIE_NAME]: '/account',
      });
      mockExchangeCodeForTokens.mockResolvedValue(VALID_TOKENS);
    });

    // Test 11, 12 — SC-03, SC-17
    it('sets the id-token cookie under its existing name, httpOnly, path /', async () => {
      await GET(requestFor({ code: 'auth-code-1', state: 'state-1' }));

      const calls = setCalledFor(ID_TOKEN_COOKIE_NAME);
      expect(calls).toHaveLength(1);
      const [, value, options] = calls[0] as [string, string, { httpOnly: boolean; path: string }];
      expect(value).toBe(VALID_TOKENS.id_token);
      expect(options.httpOnly).toBe(true);
      expect(options.path).toBe('/');
    });

    // Test 13 — SC-06
    it('stores the refresh token in its own httpOnly cookie', async () => {
      await GET(requestFor({ code: 'auth-code-1', state: 'state-1' }));

      const calls = setCalledFor(REFRESH_TOKEN_COOKIE_NAME);
      expect(calls).toHaveLength(1);
      const [, value, options] = calls[0] as [string, string, { httpOnly: boolean }];
      expect(value).toBe(VALID_TOKENS.refresh_token);
      expect(options.httpOnly).toBe(true);
    });

    // Test 14
    it('clears the state, verifier, and next cookies', async () => {
      await GET(requestFor({ code: 'auth-code-1', state: 'state-1' }));

      for (const name of [OAUTH_STATE_COOKIE_NAME, OAUTH_VERIFIER_COOKIE_NAME, OAUTH_NEXT_COOKIE_NAME]) {
        const calls = setCalledFor(name);
        expect(calls).toHaveLength(1);
        const [, value, options] = calls[0] as [string, string, { maxAge: number }];
        expect(value).toBe('');
        expect(options.maxAge).toBeLessThanOrEqual(0);
      }
    });

    // Test 15 — SC-05
    it('redirects to the stored next path', async () => {
      const response = await GET(requestFor({ code: 'auth-code-1', state: 'state-1' }));

      expect(new URL(response.headers.get('location') ?? '').pathname).toBe('/account');
    });
  });

  // Test 16
  it('re-sanitizes the stored next path, even though it was set by this app', async () => {
    setCookies({
      [OAUTH_STATE_COOKIE_NAME]: 'state-1',
      [OAUTH_VERIFIER_COOKIE_NAME]: 'verifier-1',
      [OAUTH_NEXT_COOKIE_NAME]: 'https://evil.example/steal',
    });
    mockExchangeCodeForTokens.mockResolvedValue(VALID_TOKENS);

    const response = await GET(requestFor({ code: 'auth-code-1', state: 'state-1' }));

    const location = new URL(response.headers.get('location') ?? '');
    expect(location.host).toBe('localhost:3000');
    expect(location.pathname).not.toBe('/steal');
  });

  it('defaults to /book when no next was stored', async () => {
    setCookies({ [OAUTH_STATE_COOKIE_NAME]: 'state-1', [OAUTH_VERIFIER_COOKIE_NAME]: 'verifier-1' });
    mockExchangeCodeForTokens.mockResolvedValue(VALID_TOKENS);

    const response = await GET(requestFor({ code: 'auth-code-1', state: 'state-1' }));

    expect(new URL(response.headers.get('location') ?? '').pathname).toBe('/book');
  });

  // Test 17
  it('redirects to sign-in without setting a session on a failed exchange', async () => {
    setCookies({ [OAUTH_STATE_COOKIE_NAME]: 'state-1', [OAUTH_VERIFIER_COOKIE_NAME]: 'verifier-1' });
    mockExchangeCodeForTokens.mockRejectedValue(new OAuthExchangeError('exchange failed'));

    const response = await GET(requestFor({ code: 'auth-code-1', state: 'state-1' }));

    expect(new URL(response.headers.get('location') ?? '').pathname).toBe('/auth/sign-in');
    expect(setCalledFor(ID_TOKEN_COOKIE_NAME)).toHaveLength(0);
  });

  it('does not swallow an exchange failure of an unexpected type', async () => {
    setCookies({ [OAUTH_STATE_COOKIE_NAME]: 'state-1', [OAUTH_VERIFIER_COOKIE_NAME]: 'verifier-1' });
    const unexpected = new Error('network is down');
    mockExchangeCodeForTokens.mockRejectedValue(unexpected);

    await expect(GET(requestFor({ code: 'auth-code-1', state: 'state-1' }))).rejects.toBe(unexpected);
  });
});
