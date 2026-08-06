import { describe, expect, it } from 'vitest';
import { getDatabaseEnv } from './env';

const POOLED_URL = 'postgresql://user:pass@ep-example-123-pooler.us-east-2.aws.neon.tech/keki';
const DIRECT_URL = 'postgresql://user:pass@ep-example-123.us-east-2.aws.neon.tech/keki';

function envWith(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return {
    DATABASE_URL_POOLED: POOLED_URL,
    DATABASE_URL_DIRECT: DIRECT_URL,
    ...overrides,
  };
}

describe('getDatabaseEnv', () => {
  it('resolves valid, non-swapped connection strings', () => {
    const result = getDatabaseEnv(envWith({}));
    expect(result).toEqual({ pooled: POOLED_URL, direct: DIRECT_URL });
  });

  it('throws naming DATABASE_URL_POOLED when it is missing', () => {
    expect(() => getDatabaseEnv(envWith({ DATABASE_URL_POOLED: undefined }))).toThrow(
      /DATABASE_URL_POOLED/,
    );
  });

  it('throws naming DATABASE_URL_DIRECT when it is missing', () => {
    expect(() => getDatabaseEnv(envWith({ DATABASE_URL_DIRECT: undefined }))).toThrow(
      /DATABASE_URL_DIRECT/,
    );
  });

  it('throws naming both variables when pooled and direct are swapped', () => {
    let error: unknown;
    try {
      getDatabaseEnv(
        envWith({
          DATABASE_URL_POOLED: DIRECT_URL,
          DATABASE_URL_DIRECT: POOLED_URL,
        }),
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('DATABASE_URL_POOLED');
    expect(message).toContain('DATABASE_URL_DIRECT');
  });
});
