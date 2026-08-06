import { z } from 'zod';

export interface DatabaseEnv {
  pooled: string;
  direct: string;
}

const rawEnvSchema = z.object({
  DATABASE_URL_POOLED: z
    .string({ required_error: 'DATABASE_URL_POOLED is required' })
    .url('DATABASE_URL_POOLED must be a valid connection URL'),
  DATABASE_URL_DIRECT: z
    .string({ required_error: 'DATABASE_URL_DIRECT is required' })
    .url('DATABASE_URL_DIRECT must be a valid connection URL'),
});

function hostnameOf(url: string): string {
  return new URL(url).hostname;
}

/**
 * Resolves and validates the two Neon connection strings. Accepts an
 * explicit env object (for testing) and defaults to `process.env`.
 *
 * Fails loudly rather than letting a swapped pooled/direct URL reach
 * drizzle-kit, where DDL run through the connection pooler fails in
 * confusing ways.
 */
export function getDatabaseEnv(env: NodeJS.ProcessEnv = process.env): DatabaseEnv {
  const parsed = rawEnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`)
      .join('; ');
    throw new Error(
      `Invalid database environment configuration (DATABASE_URL_POOLED, DATABASE_URL_DIRECT): ${details}`,
    );
  }

  const { DATABASE_URL_POOLED: pooled, DATABASE_URL_DIRECT: direct } = parsed.data;

  const pooledHost = hostnameOf(pooled);
  const directHost = hostnameOf(direct);

  if (!pooledHost.includes('-pooler')) {
    throw new Error(
      `DATABASE_URL_POOLED and DATABASE_URL_DIRECT appear to be swapped: ` +
        `DATABASE_URL_POOLED host "${pooledHost}" does not contain "-pooler". ` +
        `DATABASE_URL_POOLED must use the Neon pooled endpoint.`,
    );
  }

  if (directHost.includes('-pooler')) {
    throw new Error(
      `DATABASE_URL_POOLED and DATABASE_URL_DIRECT appear to be swapped: ` +
        `DATABASE_URL_DIRECT host "${directHost}" contains "-pooler". ` +
        `DATABASE_URL_DIRECT must use the Neon direct endpoint.`,
    );
  }

  return { pooled, direct };
}
