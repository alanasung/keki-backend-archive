import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearHandshakeCookies,
  clearSessionCookies,
  ID_TOKEN_COOKIE_NAME,
  OAUTH_NEXT_COOKIE_NAME,
  OAUTH_STATE_COOKIE_NAME,
  OAUTH_VERIFIER_COOKIE_NAME,
  REFRESH_TOKEN_COOKIE_NAME,
  setIdTokenCookie,
  setOAuthNextCookie,
  setOAuthStateCookie,
  setOAuthVerifierCookie,
  setRefreshTokenCookie,
  type CookieWriter,
} from './session-cookies';

function fakeStore(): { store: CookieWriter; set: ReturnType<typeof vi.fn<CookieWriter['set']>> } {
  const set = vi.fn<CookieWriter['set']>();
  return { store: { set }, set };
}

describe('session-cookies', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe.each([
    ['setIdTokenCookie', setIdTokenCookie, ID_TOKEN_COOKIE_NAME],
    ['setRefreshTokenCookie', setRefreshTokenCookie, REFRESH_TOKEN_COOKIE_NAME],
    ['setOAuthStateCookie', setOAuthStateCookie, OAUTH_STATE_COOKIE_NAME],
    ['setOAuthVerifierCookie', setOAuthVerifierCookie, OAUTH_VERIFIER_COOKIE_NAME],
    ['setOAuthNextCookie', setOAuthNextCookie, OAUTH_NEXT_COOKIE_NAME],
  ] as const)('%s', (_label, writer, cookieName) => {
    beforeEach(() => {
      // Next's global type augmentation marks `process.env.NODE_ENV` readonly
      // (apps/web/node_modules/next/types/global.d.ts), so `vi.stubEnv` —
      // rather than a direct assignment — is what setting it here has to go
      // through.
      vi.stubEnv('NODE_ENV', 'test');
    });

    it('sets the cookie httpOnly, SameSite=Lax, path /, carrying the given value', () => {
      const { store, set } = fakeStore();

      writer(store, 'the-value');

      expect(set).toHaveBeenCalledWith(
        cookieName,
        'the-value',
        expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/' }),
      );
    });

    it('is not Secure outside production', () => {
      const { store, set } = fakeStore();
      vi.stubEnv('NODE_ENV', 'test');

      writer(store, 'the-value');

      expect(set).toHaveBeenCalledWith(cookieName, 'the-value', expect.objectContaining({ secure: false }));
    });

    it('is Secure in production', () => {
      const { store, set } = fakeStore();
      vi.stubEnv('NODE_ENV', 'production');

      writer(store, 'the-value');

      expect(set).toHaveBeenCalledWith(cookieName, 'the-value', expect.objectContaining({ secure: true }));
    });
  });

  describe('clearSessionCookies', () => {
    it('expires the id token, refresh token, and handshake state/verifier cookies', () => {
      const { store, set } = fakeStore();

      clearSessionCookies(store);

      const clearedNames = set.mock.calls.map((call) => call[0]);
      expect(clearedNames).toEqual(
        expect.arrayContaining([ID_TOKEN_COOKIE_NAME, REFRESH_TOKEN_COOKIE_NAME, OAUTH_STATE_COOKIE_NAME, OAUTH_VERIFIER_COOKIE_NAME]),
      );
      expect(clearedNames).not.toContain(OAUTH_NEXT_COOKIE_NAME);
      for (const call of set.mock.calls) {
        expect(call[1]).toBe('');
        expect((call[2] as { maxAge: number }).maxAge).toBeLessThanOrEqual(0);
      }
    });
  });

  describe('clearHandshakeCookies', () => {
    it('expires the state, verifier, and next cookies, leaving the session alone', () => {
      const { store, set } = fakeStore();

      clearHandshakeCookies(store);

      const clearedNames = set.mock.calls.map((call) => call[0]);
      expect(clearedNames).toEqual(
        expect.arrayContaining([OAUTH_STATE_COOKIE_NAME, OAUTH_VERIFIER_COOKIE_NAME, OAUTH_NEXT_COOKIE_NAME]),
      );
      expect(clearedNames).not.toContain(ID_TOKEN_COOKIE_NAME);
      expect(clearedNames).not.toContain(REFRESH_TOKEN_COOKIE_NAME);
    });
  });
});
