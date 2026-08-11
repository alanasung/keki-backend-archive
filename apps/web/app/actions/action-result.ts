/**
 * Every Server Action returns this instead of throwing. A thrown error in a
 * Server Action reaches the client as an opaque digest with no message —
 * correct for leak prevention, but useless for telling a customer why their
 * cart was rejected. This envelope carries a safe, deliberate message
 * instead. See `authenticated-action.ts` and `errors.ts`.
 */
export type ActionResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: ActionError };

export interface ActionError {
  readonly code: ActionErrorCode;
  readonly message: string;
  readonly fieldErrors?: Readonly<Record<string, readonly string[]>>;
}

export const ACTION_ERROR_CODES = [
  'UNAUTHENTICATED',
  'UNPROVISIONED',
  'FORBIDDEN',
  'VALIDATION',
  'CONFLICT',
  'UNAVAILABLE',
  'INTERNAL',
] as const;
export type ActionErrorCode = (typeof ACTION_ERROR_CODES)[number];
