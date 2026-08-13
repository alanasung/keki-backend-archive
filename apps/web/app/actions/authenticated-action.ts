// Deliberately NOT a 'use server' module: `authenticatedAction` is a
// factory — its export is a plain (non-async) function that *returns* an
// async closure, and Next.js requires every export of a 'use server' file to
// itself be async. The real Server Actions boundary is each consumer file
// (e.g. (customer)/cart/actions.ts), which marks itself 'use server' and
// exports only the async closures this factory produces.
import { authorize, type AuthorizationOutcome, type Session } from '@keki/auth';
import type { Role } from '@keki/contracts';
import type { z } from 'zod';
import { getSessionResult } from '../auth/require-session';
import type { ActionError, ActionResult } from './action-result';
import { toActionError } from './errors';

const DEFAULT_REQUIRED_ROLE: Role = 'CUSTOMER';

export interface AuthenticatedActionConfig<TInput, TOutput> {
  readonly schema: z.ZodType<TInput>;
  readonly requiredRole?: Role;
  readonly handler: (input: TInput, session: Session) => Promise<TOutput>;
}

/**
 * Wraps a mutation with the one authorization boundary every Server Action
 * must go through. Mirrors `requireRole`'s three-way denial semantics
 * (`app/auth/guards.ts`) but returns an `ActionResult` instead of
 * redirecting: an action invoked by a fetch needs a result the caller can
 * act on, not a client-side navigation mid-mutation.
 */
export function authenticatedAction<TInput, TOutput>(
  config: AuthenticatedActionConfig<TInput, TOutput>,
): (raw: unknown) => Promise<ActionResult<TOutput>> {
  const requiredRole = config.requiredRole ?? DEFAULT_REQUIRED_ROLE;

  return async function run(raw: unknown): Promise<ActionResult<TOutput>> {
    // Resolve the session and authorize before parsing input: an
    // unauthenticated caller must not be able to probe validation behavior
    // to learn the shape of internal schemas.
    const result = await getSessionResult();
    const outcome = authorize({ result, requiredRole });

    if (!outcome.allowed) {
      return { ok: false, error: denialError(outcome) };
    }

    const parsed = config.schema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: 'VALIDATION',
          message: 'One or more fields are invalid.',
          fieldErrors: parsed.error.flatten().fieldErrors as Record<string, readonly string[]>,
        },
      };
    }

    try {
      const data = await config.handler(parsed.data, outcome.session);
      return { ok: true, data };
    } catch (error) {
      return { ok: false, error: toActionError(error) };
    }
  };
}

// Keeps the three denial reasons distinct, matching `requireRole`'s three
// destinations: collapsing them would make a provisioning gap look like a
// permissions failure.
function denialError(outcome: Extract<AuthorizationOutcome, { allowed: false }>): ActionError {
  switch (outcome.reason) {
    case 'anonymous':
      return { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' };
    case 'unprovisioned':
      return { code: 'UNPROVISIONED', message: 'Finish setting up your profile to continue.' };
    case 'insufficient_role':
      return { code: 'FORBIDDEN', message: 'You do not have permission to do that.' };
  }
}
