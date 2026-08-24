import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ID_TOKEN_COOKIE_NAME, REFRESH_TOKEN_COOKIE_NAME } from '../../session-cookies';

const { mockCookiesSet } = vi.hoisted(() => ({ mockCookiesSet: vi.fn() }));

vi.mock('next/headers', () => ({
  cookies: vi.fn(() => Promise.resolve({ set: mockCookiesSet })),
}));

const { GET } = await import('./route');

describe('/auth/sign-out/complete', () => {
  beforeEach(() => {
    mockCookiesSet.mockReset();
  });

  // Test 21
  it('clears the session cookies and lands on /', async () => {
    const response = await GET(new NextRequest(new URL('http://localhost:3000/auth/sign-out/complete')));

    expect(new URL(response.headers.get('location') ?? '').pathname).toBe('/');
    for (const name of [ID_TOKEN_COOKIE_NAME, REFRESH_TOKEN_COOKIE_NAME]) {
      const call = mockCookiesSet.mock.calls.find((entry) => entry[0] === name);
      expect(call?.[1]).toBe('');
    }
  });

  it('clears cookies even for a user who arrived directly, without a prior sign-out', async () => {
    const response = await GET(new NextRequest(new URL('http://localhost:3000/auth/sign-out/complete')));

    expect(response.status).toBe(307);
  });
});
