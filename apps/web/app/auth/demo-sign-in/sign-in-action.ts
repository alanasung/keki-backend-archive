'use server';

import type { Route } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ID_TOKEN_COOKIE_NAME } from '@keki/auth/cookies';
import { ROLES } from '@keki/contracts';
import { sanitizeNextPath } from '../guards';
import { demoTokenEnvVar, isDemoSignInEnabled } from './demo-config';

/**
 * Signs the browser in as one of the seeded demo users by installing a
 * pre-minted id token as the session cookie.
 *
 * Phase 1 built the authorization gate but not a sign-in form —
 * `/auth/sign-in` is still a placeholder, because Cognito's hosted flow is
 * later work. That leaves the gate impossible to demonstrate interactively:
 * every protected route redirects, and nothing can get past it.
 *
 * This does not weaken the gate. The tokens are real — signed by the demo
 * JWKS issuer and verified by `packages/auth` like any other, with issuer,
 * audience, and expiry all checked. Nothing here bypasses `authorize`; it
 * only supplies a credential the UI otherwise has no way to obtain.
 *
 * The tokens arrive as environment variables minted by
 * `scripts/demo-serve.ts`. Deliberately not generated here: that would mean
 * app code importing the e2e signing-key fixture, and would make the
 * capability latent in every build rather than present only when the demo
 * script supplied it.
 */

function readFormString(formData: FormData, key: string): string | null {
  const value = formData.get(key);
  // FormDataEntryValue is `string | File`; only a string is meaningful here,
  // and stringifying a File would silently yield "[object Object]".
  return typeof value === 'string' ? value : null;
}

export async function demoSignInAction(formData: FormData): Promise<void> {
  if (!isDemoSignInEnabled()) {
    throw new Error('Demo sign-in is disabled.');
  }

  const rawRole = readFormString(formData, 'role');
  const role = ROLES.find((candidate) => candidate === rawRole);
  if (role === undefined) {
    throw new Error('Unknown demo role.');
  }

  const token = process.env[demoTokenEnvVar(role)];
  if (token === undefined || token.length === 0) {
    throw new Error(`No demo token available for ${role}.`);
  }

  // Same-origin relative paths only. `sanitizeNextPath` exists because a
  // `next` parameter is the classic open-redirect vector, and that reasoning
  // applies here exactly as it does on the real sign-in page.
  const next = sanitizeNextPath(readFormString(formData, 'next'));

  const store = await cookies();
  store.set(ID_TOKEN_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: false, // localhost only; this route cannot run in production.
    path: '/',
    maxAge: 60 * 60 * 2,
  });

  // `next` is validated at runtime by sanitizeNextPath but is not a
  // statically known route, which `typedRoutes: true` requires — hence the
  // cast, applied after validation and never before.
  //
  // Whether that cast is *needed* depends on the environment, which is why
  // it carries a disable directive. `tsc` only sees `RouteImpl` once Next has
  // generated `.next/types`, so locally (after a dev run or build) the
  // assertion is required, while in CI — where lint runs on a fresh checkout,
  // before any build — `redirect` still accepts a plain string and the rule
  // reports the assertion as unnecessary. Keeping the cast satisfies the
  // stricter of the two; the directive silences the looser one. It is
  // reported as unused rather than as an error where the cast is genuinely
  // needed, so both environments pass.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  redirect(next as Route);
}

export async function demoSignOutAction(): Promise<void> {
  const store = await cookies();
  store.delete(ID_TOKEN_COOKIE_NAME);
  redirect('/auth/demo-sign-in');
}
