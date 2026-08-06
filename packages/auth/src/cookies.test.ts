import { describe, expect, it } from 'vitest';
import { extractToken, ID_TOKEN_COOKIE_NAME } from './cookies';

describe('extractToken', () => {
  it('returns null when there is no cookie header', () => {
    expect(extractToken(null)).toBeNull();
  });

  it('returns null when the id token cookie is absent', () => {
    expect(extractToken('other=value; another=thing')).toBeNull();
  });

  it('extracts the id token when it is the only cookie', () => {
    expect(extractToken(`${ID_TOKEN_COOKIE_NAME}=abc.def.ghi`)).toBe('abc.def.ghi');
  });

  it('extracts the id token from among several cookies', () => {
    expect(extractToken(`session_ui=1; ${ID_TOKEN_COOKIE_NAME}=abc.def.ghi; other=2`)).toBe('abc.def.ghi');
  });

  it('decodes a URL-encoded value', () => {
    expect(extractToken(`${ID_TOKEN_COOKIE_NAME}=abc%2Fdef`)).toBe('abc/def');
  });

  it('returns null for an empty value', () => {
    expect(extractToken(`${ID_TOKEN_COOKIE_NAME}=`)).toBeNull();
  });
});
