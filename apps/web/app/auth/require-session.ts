import { extractToken, resolveSession, type SessionResult } from '@keki/auth';
import { headers } from 'next/headers';
import { cache } from 'react';

/**
 * Resolves the current request's session. Cached per request via React's
 * `cache()` so the several nested layouts that each guard a route (see
 * `guards.ts`) share one JWKS check and one profile lookup instead of one
 * each. This is a thin framework binding only: verification and the profile
 * lookup belong to `resolveSession` in `@keki/auth` (WS-04's), and a token
 * that fails verification already resolves to `anonymous` there rather than
 * throwing — do not add a second try/catch here that could mask a genuine
 * configuration error.
 */
export const getSessionResult = cache(async (): Promise<SessionResult> => {
  const headerList = await headers();
  const token = extractToken(headerList.get('cookie'));
  return resolveSession(token);
});
