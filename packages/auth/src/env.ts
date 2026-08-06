import { z } from 'zod';
import { AuthConfigError } from './errors';

export interface CognitoEnv {
  readonly userPoolId: string;
  readonly clientId: string;
  readonly region: string;
  readonly issuer: string;
  readonly jwksUri: string;
}

const rawEnvSchema = z.object({
  COGNITO_USER_POOL_ID: z
    .string({ required_error: 'COGNITO_USER_POOL_ID is required' })
    .min(1, 'COGNITO_USER_POOL_ID is required'),
  COGNITO_CLIENT_ID: z
    .string({ required_error: 'COGNITO_CLIENT_ID is required' })
    .min(1, 'COGNITO_CLIENT_ID is required'),
  AWS_REGION: z
    .string({ required_error: 'AWS_REGION is required' })
    .min(1, 'AWS_REGION is required'),
  // Test-only overrides so WS-12's Playwright fixtures can point verification
  // at a locally served JWKS with a test key pair, instead of a real Cognito
  // pool. Guarded against production below.
  COGNITO_ISSUER: z.string().min(1).optional(),
  COGNITO_JWKS_URI: z.string().min(1).optional(),
  NODE_ENV: z.string().optional(),
});

/**
 * Resolves and validates Cognito configuration. Fails loudly, naming the
 * missing variable, rather than letting `undefined` reach the JWT verifier
 * where a missing issuer silently disables issuer checking.
 */
function resolveCognitoEnv(env: NodeJS.ProcessEnv): CognitoEnv {
  const parsed = rawEnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`)
      .join('; ');
    throw new AuthConfigError(`Invalid Cognito environment configuration: ${details}`);
  }

  const {
    COGNITO_USER_POOL_ID: userPoolId,
    COGNITO_CLIENT_ID: clientId,
    AWS_REGION: region,
    COGNITO_ISSUER: issuerOverride,
    COGNITO_JWKS_URI: jwksUriOverride,
    NODE_ENV: nodeEnv,
  } = parsed.data;

  if ((issuerOverride !== undefined || jwksUriOverride !== undefined) && nodeEnv === 'production') {
    // An issuer override in production is an authentication bypass: anyone
    // who can set the variable can mint tokens accepted as genuine.
    throw new AuthConfigError(
      'COGNITO_ISSUER and COGNITO_JWKS_URI overrides are not permitted when NODE_ENV=production.',
    );
  }

  const issuer = issuerOverride ?? `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
  const jwksUri = jwksUriOverride ?? `${issuer}/.well-known/jwks.json`;

  return { userPoolId, clientId, region, issuer, jwksUri };
}

// WS-10 supplies these via SST resource linking. Resolved eagerly so a
// missing variable fails at import time, not on the first authenticated
// request.
export const cognitoEnv: CognitoEnv = resolveCognitoEnv(process.env);
