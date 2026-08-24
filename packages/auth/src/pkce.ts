import { createHash, randomBytes } from 'node:crypto';
import type { AuthorizationRequest, PkcePair } from '@keki/contracts';
import { cognitoEnv } from './env';
import { cognitoOAuthEnv } from './oauth-env';

/**
 * Split from `oauth.ts` (not just organizationally): this file's
 * `node:crypto` import makes it Node-only, and `middleware.ts` imports
 * `refreshSession`/`shouldRefresh` from `@keki/auth/oauth` on the Edge
 * runtime, which cannot bundle a `node:` scheme import — even one it never
 * calls, since webpack cannot tree-shake an import statement other exports
 * in the same module still use. `buildAuthorizationUrl` is only ever called
 * from the sign-in Route Handler, which runs on the Node runtime, so this
 * file has no Edge constraint of its own.
 */

/**
 * 32 random bytes, base64url, no padding. Node's `'base64url'` encoding is
 * already RFC 4648 §5 (`+`→`-`, `/`→`_`, `=` stripped), so no manual
 * translation is needed.
 */
function randomBase64Url(): string {
  return randomBytes(32).toString('base64url');
}

/** PKCE verifier and its S256 challenge — RFC 7636. */
export function createPkcePair(): PkcePair {
  const verifier = randomBase64Url();
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * Builds the Cognito hosted-UI authorization URL for the code flow with
 * PKCE. The redirect URI is never a parameter — it always comes from
 * `cognitoOAuthEnv`, because a caller-supplied redirect would be an open
 * redirect and Cognito's exact-match client registration is the only thing
 * that would catch it.
 */
export function buildAuthorizationUrl(input?: { now?: () => number }): AuthorizationRequest {
  // Accepted for interface symmetry with the rest of the handshake (e.g.
  // `shouldRefresh`'s injectable clock); the authorization URL carries no
  // timestamp of its own, so `now` is not consulted.
  void input?.now;

  const { verifier, challenge } = createPkcePair();
  const state = randomBase64Url();

  const url = new URL('/oauth2/authorize', cognitoOAuthEnv.hostedUiUrl);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: cognitoEnv.clientId,
    redirect_uri: cognitoOAuthEnv.redirectUri,
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();

  return { url: url.toString(), state, verifier };
}
