import { ROLES, type Role } from '@keki/contracts';

/**
 * Pure configuration for the demo sign-in route.
 *
 * Kept out of `sign-in-action.ts` because every export of a `'use server'`
 * module must be an async server action; these are synchronous predicates,
 * and forcing them into that shape would misrepresent them as callable from
 * the client.
 */

/** Env var carrying the pre-minted token for a role, e.g. KEKI_DEMO_TOKEN_ADMIN. */
export function demoTokenEnvVar(role: Role): string {
  return `KEKI_DEMO_TOKEN_${role}`;
}

/**
 * Both conditions are required. The production check alone would leave the
 * route live on any non-production build; the flag alone would leave it one
 * misconfigured NODE_ENV away from a deployed stage.
 */
export function isDemoSignInEnabled(): boolean {
  return (
    process.env['NODE_ENV'] !== 'production' && process.env['KEKI_ENABLE_DEMO_SIGN_IN'] === 'true'
  );
}

/**
 * Only roles the demo script actually minted a token for. Without the script
 * there are none, so the page renders an explanation rather than offering
 * buttons that cannot work.
 */
export function availableDemoRoles(): readonly Role[] {
  if (!isDemoSignInEnabled()) {
    return [];
  }
  return ROLES.filter((role) => {
    const token = process.env[demoTokenEnvVar(role)];
    return token !== undefined && token.length > 0;
  });
}
