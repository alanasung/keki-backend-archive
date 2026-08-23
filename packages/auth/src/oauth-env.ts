import { z } from 'zod';
import { AuthConfigError } from './errors';

export interface CognitoOAuthEnv {
  readonly hostedUiUrl: string;
  readonly redirectUri: string;
  readonly signOutUri: string;
}

const rawOAuthEnvSchema = z.object({
  COGNITO_HOSTED_UI_URL: z
    .string({ required_error: 'COGNITO_HOSTED_UI_URL is required' })
    .min(1, 'COGNITO_HOSTED_UI_URL is required'),
  COGNITO_REDIRECT_URI: z
    .string({ required_error: 'COGNITO_REDIRECT_URI is required' })
    .min(1, 'COGNITO_REDIRECT_URI is required'),
  COGNITO_SIGN_OUT_URI: z
    .string({ required_error: 'COGNITO_SIGN_OUT_URI is required' })
    .min(1, 'COGNITO_SIGN_OUT_URI is required'),
  NODE_ENV: z.string().optional(),
});

function assertHttpsInProduction(name: string, value: string, nodeEnv: string | undefined): void {
  if (nodeEnv !== 'production') {
    return;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AuthConfigError(`${name} ("${value}") is not a valid URL.`);
  }

  if (url.protocol !== 'https:') {
    // An http:// URL in production puts an authorization code (redirect
    // URI) or a session-ending request (sign-out URI) on the wire in clear
    // text.
    throw new AuthConfigError(`${name} ("${value}") must use https when NODE_ENV=production.`);
  }
}

/**
 * Resolves and validates the OAuth handshake configuration WS-02 supplies.
 * Mirrors `env.ts`'s `resolveCognitoEnv`: fails loudly, naming the missing
 * variable, rather than letting `undefined` reach a URL builder where it
 * would silently produce a broken authorization or logout link.
 */
function resolveCognitoOAuthEnv(env: NodeJS.ProcessEnv): CognitoOAuthEnv {
  const parsed = rawOAuthEnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`)
      .join('; ');
    throw new AuthConfigError(`Invalid Cognito OAuth environment configuration: ${details}`);
  }

  const {
    COGNITO_HOSTED_UI_URL: hostedUiUrl,
    COGNITO_REDIRECT_URI: redirectUri,
    COGNITO_SIGN_OUT_URI: signOutUri,
    NODE_ENV: nodeEnv,
  } = parsed.data;

  assertHttpsInProduction('COGNITO_HOSTED_UI_URL', hostedUiUrl, nodeEnv);
  assertHttpsInProduction('COGNITO_REDIRECT_URI', redirectUri, nodeEnv);
  assertHttpsInProduction('COGNITO_SIGN_OUT_URI', signOutUri, nodeEnv);

  return { hostedUiUrl, redirectUri, signOutUri };
}

// Resolved eagerly, same as `cognitoEnv`, so a missing or non-https variable
// fails at import time rather than on the first sign-in attempt.
export const cognitoOAuthEnv: CognitoOAuthEnv = resolveCognitoOAuthEnv(process.env);
