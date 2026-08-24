import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dir = dirname(fileURLToPath(import.meta.url));

const { mockResolveSession, mockHeadersGet } = vi.hoisted(() => ({
  mockResolveSession: vi.fn(),
  mockHeadersGet: vi.fn(),
}));

vi.mock('@keki/auth', () => ({
  resolveSession: mockResolveSession,
  extractToken: (cookieHeader: string | null) => cookieHeader,
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve({ get: mockHeadersGet })),
}));

// React's real `cache()` only memoizes inside the request-scoped dispatcher
// Next.js installs while actually rendering (see the `react-server` build's
// implementation, which no-ops to a plain passthrough when that dispatcher
// is absent). Called directly from a Vitest test, there is no dispatcher, so
// the unmocked `cache()` would not memoize at all and this test would prove
// nothing. Mocking it with a working memoize verifies *our* wrapping — that
// `getSessionResult` is deduped — independent of React's internal, request-
// scoped mechanics, which are React's contract to keep, not this file's.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    cache<Args extends unknown[], R>(fn: (...args: Args) => R): (...args: Args) => R {
      let called = false;
      let result: R;
      return (...args: Args): R => {
        if (!called) {
          called = true;
          result = fn(...args);
        }
        return result;
      };
    },
  };
});

/** Only the `cookie` header responds; the refreshed-token header is absent, as on a request middleware did not refresh. */
function mockOnlyCookieHeader(cookieValue: string): void {
  mockHeadersGet.mockImplementation((name: string) => (name === 'cookie' ? cookieValue : null));
}

describe('getSessionResult', () => {
  beforeEach(() => {
    vi.resetModules();
    mockResolveSession.mockReset();
    mockHeadersGet.mockReset();
  });

  it('is wrapped in cache()', () => {
    const source = readFileSync(join(dir, 'require-session.ts'), 'utf-8');
    expect(source).toMatch(/cache\(async/);
  });

  // Case 9: the actual invalid-token-to-anonymous mapping is resolveSession's
  // contract, proven in packages/auth/src/session.test.ts. What belongs to
  // this file is that it does not add a second layer of error handling on
  // top — it simply forwards resolveSession's result or its rejection.
  it('forwards an anonymous result from resolveSession without throwing', async () => {
    mockOnlyCookieHeader('keki_id_token=expired-or-invalid');
    mockResolveSession.mockResolvedValue({ kind: 'anonymous' });

    const { getSessionResult } = await import('./require-session');

    await expect(getSessionResult()).resolves.toEqual({ kind: 'anonymous' });
  });

  it('does not swallow a rejection resolveSession does not itself catch', async () => {
    mockOnlyCookieHeader('keki_id_token=whatever');
    const configError = new Error('a genuine configuration error');
    mockResolveSession.mockRejectedValue(configError);

    const { getSessionResult } = await import('./require-session');

    await expect(getSessionResult()).rejects.toBe(configError);
  });

  // Case 10
  it('resolves the session once per request, not once per call', async () => {
    mockOnlyCookieHeader('keki_id_token=whatever');
    mockResolveSession.mockResolvedValue({ kind: 'anonymous' });

    const { getSessionResult } = await import('./require-session');

    await getSessionResult();
    await getSessionResult();
    await getSessionResult();

    expect(mockResolveSession).toHaveBeenCalledTimes(1);
  });

  describe('a token middleware refreshed', () => {
    it('resolves the session from the refreshed-token header, not the (still valid, but about to expire) cookie', async () => {
      mockHeadersGet.mockImplementation((name: string) =>
        name === 'x-keki-refreshed-id-token' ? 'refreshed-token' : 'keki_id_token=near-expiry-token',
      );
      mockResolveSession.mockResolvedValue({ kind: 'anonymous' });

      const { getSessionResult } = await import('./require-session');
      await getSessionResult();

      expect(mockResolveSession).toHaveBeenCalledWith('refreshed-token');
    });

    it('falls back to the cookie when middleware did not refresh', async () => {
      mockOnlyCookieHeader('keki_id_token=whatever');
      mockResolveSession.mockResolvedValue({ kind: 'anonymous' });

      const { getSessionResult } = await import('./require-session');
      await getSessionResult();

      expect(mockResolveSession).toHaveBeenCalledWith('keki_id_token=whatever');
    });
  });
});
