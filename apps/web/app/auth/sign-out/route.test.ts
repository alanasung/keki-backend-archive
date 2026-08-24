import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ID_TOKEN_COOKIE_NAME, OAUTH_STATE_COOKIE_NAME, OAUTH_VERIFIER_COOKIE_NAME, REFRESH_TOKEN_COOKIE_NAME } from '../session-cookies';

const SIGN_OUT_URL = 'https://keki-test.auth.us-east-1.amazoncognito.com/logout?client_id=test-client-id';

const { mockBuildSignOutUrl } = vi.hoisted(() => ({
  mockBuildSignOutUrl: vi.fn(() => SIGN_OUT_URL),
}));

vi.mock('@keki/auth', () => ({ buildSignOutUrl: mockBuildSignOutUrl }));

const { mockCookiesSet } = vi.hoisted(() => ({ mockCookiesSet: vi.fn() }));

vi.mock('next/headers', () => ({
  cookies: vi.fn(() => Promise.resolve({ set: mockCookiesSet })),
}));

const { GET } = await import('./route');

describe('/auth/sign-out', () => {
  beforeEach(() => {
    mockCookiesSet.mockReset();
  });

  // Test 19
  it('clears all four cookies', async () => {
    await GET();

    for (const name of [ID_TOKEN_COOKIE_NAME, REFRESH_TOKEN_COOKIE_NAME, OAUTH_STATE_COOKIE_NAME, OAUTH_VERIFIER_COOKIE_NAME]) {
      const call = mockCookiesSet.mock.calls.find((entry) => entry[0] === name) as
        | [string, string, { maxAge: number }]
        | undefined;
      expect(call?.[1]).toBe('');
      expect(call?.[2]?.maxAge).toBeLessThanOrEqual(0);
    }
  });

  // Test 20 — SC-07
  it("redirects to Cognito's logout URL", async () => {
    const response = await GET();

    expect(response.headers.get('location')).toBe(SIGN_OUT_URL);
  });
});
