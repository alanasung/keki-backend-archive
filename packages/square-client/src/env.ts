import { z } from 'zod';

export interface SquareConfig {
  readonly accessToken: string;
  readonly environment: 'sandbox' | 'production';
  readonly webhookSignatureKey: string;
  readonly notificationUrl: string;
}

export class SquareConfigError extends Error {
  readonly kind = 'SquareConfigError' as const;

  constructor(message: string) {
    super(message);
    this.name = 'SquareConfigError';
  }
}

const rawEnvSchema = z.object({
  SQUARE_ACCESS_TOKEN: z
    .string({ required_error: 'SQUARE_ACCESS_TOKEN is required' })
    .min(1, 'SQUARE_ACCESS_TOKEN is required'),
  SQUARE_ENVIRONMENT: z.enum(['sandbox', 'production'], {
    required_error: 'SQUARE_ENVIRONMENT is required',
    invalid_type_error: 'SQUARE_ENVIRONMENT must be "sandbox" or "production"',
  }),
  SQUARE_WEBHOOK_SIGNATURE_KEY: z
    .string({ required_error: 'SQUARE_WEBHOOK_SIGNATURE_KEY is required' })
    .min(1, 'SQUARE_WEBHOOK_SIGNATURE_KEY is required'),
  SQUARE_NOTIFICATION_URL: z
    .string({ required_error: 'SQUARE_NOTIFICATION_URL is required' })
    .url('SQUARE_NOTIFICATION_URL must be a valid URL'),
  NODE_ENV: z.string().optional(),
});

/**
 * Resolves and validates Square credentials. Accepts an explicit env object
 * (for testing) and defaults to `process.env`.
 *
 * Refuses SQUARE_ENVIRONMENT=sandbox under NODE_ENV=production — mirrors
 * @keki/auth's COGNITO_ISSUER/COGNITO_JWKS_URI production refusal. This is
 * the named mitigation for transposed-credentials risk: running production
 * against sandbox means customers appear to pay and no money moves.
 */
export function resolveSquareConfig(env: NodeJS.ProcessEnv = process.env): SquareConfig {
  const parsed = rawEnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`)
      .join('; ');
    throw new SquareConfigError(`Invalid Square environment configuration: ${details}`);
  }

  const {
    SQUARE_ACCESS_TOKEN: accessToken,
    SQUARE_ENVIRONMENT: environment,
    SQUARE_WEBHOOK_SIGNATURE_KEY: webhookSignatureKey,
    SQUARE_NOTIFICATION_URL: notificationUrl,
    NODE_ENV: nodeEnv,
  } = parsed.data;

  if (nodeEnv === 'production' && environment === 'sandbox') {
    throw new SquareConfigError(
      'SQUARE_ENVIRONMENT=sandbox is not permitted when NODE_ENV=production: a transposed-credentials ' +
        'mistake here means customers appear to pay while no money moves.',
    );
  }

  return { accessToken, environment, webhookSignatureKey, notificationUrl };
}
