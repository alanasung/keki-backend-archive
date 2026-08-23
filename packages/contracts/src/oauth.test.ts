import { describe, expect, it } from 'vitest';
import { cognitoTokenResponseSchema } from './oauth';

const validPayload = {
  id_token: 'id-token-value',
  access_token: 'access-token-value',
  refresh_token: 'refresh-token-value',
  expires_in: 3600,
  token_type: 'Bearer',
};

describe('cognitoTokenResponseSchema', () => {
  it('accepts a response without a refresh token', () => {
    const withoutRefresh: Record<string, unknown> = { ...validPayload };
    delete withoutRefresh.refresh_token;
    const result = cognitoTokenResponseSchema.safeParse(withoutRefresh);
    expect(result.success).toBe(true);
  });

  it('accepts unknown fields', () => {
    const result = cognitoTokenResponseSchema.safeParse({ ...validPayload, scope: 'openid' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scope).toBe('openid');
    }
  });

  it('rejects a missing id_token', () => {
    const withoutIdToken: Record<string, unknown> = { ...validPayload };
    delete withoutIdToken.id_token;
    const result = cognitoTokenResponseSchema.safeParse(withoutIdToken);
    expect(result.success).toBe(false);
  });

  it('rejects a non-numeric expires_in', () => {
    const result = cognitoTokenResponseSchema.safeParse({ ...validPayload, expires_in: 'soon' });
    expect(result.success).toBe(false);
  });
});
