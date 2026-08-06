export const ID_TOKEN_COOKIE_NAME = 'keki_id_token';

/**
 * Parses a raw `Cookie` request header for the id token. Pure and
 * framework-agnostic so the Edge middleware (which only has the raw header)
 * and the server-side guards (which read via `next/headers`) agree on where
 * the token lives, instead of each hand-rolling its own lookup.
 */
export function extractToken(cookieHeader: string | null): string | null {
  if (cookieHeader === null) {
    return null;
  }

  for (const pair of cookieHeader.split(';')) {
    const separatorIndex = pair.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const name = pair.slice(0, separatorIndex).trim();
    if (name !== ID_TOKEN_COOKIE_NAME) {
      continue;
    }

    const value = pair.slice(separatorIndex + 1).trim();
    return value.length > 0 ? decodeURIComponent(value) : null;
  }

  return null;
}
