import { z } from 'zod';

// ---------------------------------------------------------------------------
// OAuth handshake types — the values the auth library and the routes that
// drive the Cognito handshake pass between each other.
// ---------------------------------------------------------------------------

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
}

export interface AuthorizationRequest {
  readonly url: string;
  readonly state: string;
  readonly verifier: string;
}

// .passthrough(), not .strict() — this is the one schema in the program
// where that is right: the token response comes from Cognito, not from a
// user, and rejecting it because AWS added a field would break sign-in for
// everyone at a moment of their choosing.
//
// refresh_token is optional because Cognito omits it on a refresh exchange
// — it returns a new id token and reuses the existing refresh token.
// Requiring it would make every refresh fail.
export const cognitoTokenResponseSchema = z
  .object({
    id_token: z.string().min(1),
    access_token: z.string().min(1),
    refresh_token: z.string().min(1).optional(),
    expires_in: z.number().int().positive(),
    token_type: z.string(),
  })
  .passthrough();

export type CognitoTokenResponse = z.infer<typeof cognitoTokenResponseSchema>;
