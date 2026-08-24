'use server';

import type { Route } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { completeProfileSchema } from '@keki/contracts';
import { provisionCustomerProfile } from '@keki/customer-core';
import type { ActionResult } from '../../actions/action-result';
import { sanitizeNextPath } from '../guards';
import { getSessionResult } from '../require-session';
import { OAUTH_NEXT_COOKIE_NAME } from '../session-cookies';

const DEFAULT_NEXT_PATH = '/book';

// Postgres's unique-violation SQLSTATE. `customers.cognito_sub` is unique, so
// a genuine concurrent double-submit that loses the check-then-act race in
// `provisionCustomerProfile` surfaces this way — see that function's own
// comment for why the common case (two tabs submitting the same profile) is
// already absorbed there via `onConflictDoNothing`, and this only guards the
// residual case. Drizzle wraps driver errors in a `DrizzleQueryError` and
// leaves the SQLSTATE one level down on `.cause` (see
// packages/reservation-core/src/commands.ts's identical `isCapacityExceededError`),
// so the chain must be walked rather than checking only the top-level error.
const UNIQUE_VIOLATION_SQLSTATE = '23505';
const MAX_CAUSE_DEPTH = 8;

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) {
      return false;
    }
    if ((current as { code?: unknown }).code === UNIQUE_VIOLATION_SQLSTATE) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }

  return false;
}

/**
 * The one mutation in the app whose entire purpose is to run before a
 * customer profile exists, so it cannot go through `authenticatedAction`:
 * that wrapper's `authorize` call denies the `unprovisioned` case, which
 * would make profile creation impossible. Instead this resolves the session
 * itself and accepts only `unprovisioned`, rejecting every other case.
 *
 * `cognitoSub` and `email` come from the verified session, never from the
 * submitted payload — `completeProfileSchema` (WS-01) deliberately has no
 * field for either, so there is no input this action reads them from even by
 * accident.
 */
export async function completeProfileAction(raw: unknown): Promise<ActionResult<void>> {
  const result = await getSessionResult();

  if (result.kind === 'anonymous') {
    return { ok: false, error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } };
  }
  if (result.kind === 'authenticated') {
    return { ok: false, error: { code: 'CONFLICT', message: 'Your profile is already set up.' } };
  }

  const parsed = completeProfileSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'VALIDATION',
        message: 'One or more fields are invalid.',
        fieldErrors: parsed.error.flatten().fieldErrors,
      },
    };
  }

  if (result.email === undefined) {
    console.error('completeProfileAction: unprovisioned session has no email claim.');
    return { ok: false, error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.' } };
  }

  try {
    await provisionCustomerProfile({
      cognitoSub: result.cognitoSub,
      email: result.email,
      firstName: parsed.data.firstName,
      lastName: parsed.data.lastName,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return {
        ok: false,
        error: { code: 'CONFLICT', message: 'Your profile was already created. Please try again.' },
      };
    }
    console.error(error);
    return { ok: false, error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.' } };
  }

  const store = await cookies();
  const storedNext = store.get(OAUTH_NEXT_COOKIE_NAME)?.value ?? null;
  const destination = storedNext === null ? DEFAULT_NEXT_PATH : sanitizeNextPath(storedNext);
  // `destination` is validated at runtime by `sanitizeNextPath`/the
  // `DEFAULT_NEXT_PATH` constant but is not a statically known route, which
  // `typedRoutes: true` requires — see sign-in-action.ts for why this cast
  // (applied only after validation) is needed locally but reported as
  // unnecessary in CI, where lint runs before `.next/types` exists.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  redirect(destination as Route);
}
