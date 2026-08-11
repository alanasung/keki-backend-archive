import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { verifySquareSignature } from './verify-signature';

const SIGNING_KEY = 'test-signing-key';
const NOTIFICATION_URL = 'https://example.com/webhooks/square';
const RAW_BODY = JSON.stringify({ merchant_id: 'M1', type: 'payment.updated' });

function sign(notificationUrl: string, rawBody: string, signingKey = SIGNING_KEY): string {
  return createHmac('sha256', signingKey)
    .update(notificationUrl + rawBody, 'utf8')
    .digest('base64');
}

function flipLastChar(value: string): string {
  const last = value.at(-1) ?? 'A';
  const replacement = last === 'A' ? 'B' : 'A';
  return value.slice(0, -1) + replacement;
}

describe('verifySquareSignature', () => {
  it('verifies a valid signature', () => {
    const signature = sign(NOTIFICATION_URL, RAW_BODY);

    expect(
      verifySquareSignature({
        rawBody: RAW_BODY,
        signature,
        signingKey: SIGNING_KEY,
        notificationUrl: NOTIFICATION_URL,
      }),
    ).toBe(true);
  });

  it('rejects a forged signature (one byte altered)', () => {
    const signature = flipLastChar(sign(NOTIFICATION_URL, RAW_BODY));

    expect(
      verifySquareSignature({
        rawBody: RAW_BODY,
        signature,
        signingKey: SIGNING_KEY,
        notificationUrl: NOTIFICATION_URL,
      }),
    ).toBe(false);
  });

  it('rejects when the body is tampered with, signature unchanged', () => {
    const signature = sign(NOTIFICATION_URL, RAW_BODY);

    expect(
      verifySquareSignature({
        rawBody: RAW_BODY + 'tampered',
        signature,
        signingKey: SIGNING_KEY,
        notificationUrl: NOTIFICATION_URL,
      }),
    ).toBe(false);
  });

  it('rejects a signature computed for a different notification URL (proves the URL is part of the MAC)', () => {
    const signature = sign('https://example.com/webhooks/OTHER', RAW_BODY);

    expect(
      verifySquareSignature({
        rawBody: RAW_BODY,
        signature,
        signingKey: SIGNING_KEY,
        notificationUrl: NOTIFICATION_URL,
      }),
    ).toBe(false);
  });

  it('rejects a signature computed as body-then-URL (wrong concatenation order)', () => {
    const wrongOrderSignature = createHmac('sha256', SIGNING_KEY)
      .update(RAW_BODY + NOTIFICATION_URL, 'utf8')
      .digest('base64');

    expect(
      verifySquareSignature({
        rawBody: RAW_BODY,
        signature: wrongOrderSignature,
        signingKey: SIGNING_KEY,
        notificationUrl: NOTIFICATION_URL,
      }),
    ).toBe(false);
  });

  it('returns false rather than throwing on a truncated base64 signature', () => {
    const signature = sign(NOTIFICATION_URL, RAW_BODY).slice(0, 10);

    expect(() =>
      verifySquareSignature({
        rawBody: RAW_BODY,
        signature,
        signingKey: SIGNING_KEY,
        notificationUrl: NOTIFICATION_URL,
      }),
    ).not.toThrow();
    expect(
      verifySquareSignature({
        rawBody: RAW_BODY,
        signature,
        signingKey: SIGNING_KEY,
        notificationUrl: NOTIFICATION_URL,
      }),
    ).toBe(false);
  });

  it('does not throw on a non-base64 signature', () => {
    expect(() =>
      verifySquareSignature({
        rawBody: RAW_BODY,
        signature: '!!!not-base64!!!',
        signingKey: SIGNING_KEY,
        notificationUrl: NOTIFICATION_URL,
      }),
    ).not.toThrow();
  });

  it('verifies an empty body with a valid signature (bodyless test pings)', () => {
    const signature = sign(NOTIFICATION_URL, '');

    expect(
      verifySquareSignature({
        rawBody: '',
        signature,
        signingKey: SIGNING_KEY,
        notificationUrl: NOTIFICATION_URL,
      }),
    ).toBe(true);
  });

  it('uses crypto.timingSafeEqual and contains no === comparison of signature bytes', () => {
    const source = readFileSync(new URL('./verify-signature.ts', import.meta.url), 'utf8');

    expect(source).toContain('timingSafeEqual(');
    // Not a bare `.not.toContain('===')` — prose explaining why `===` is
    // avoided may legitimately mention the token. This checks for an
    // actual comparison of the signature-related identifiers instead.
    expect(source).not.toMatch(/(expected|provided|signature)\s*===/);
  });
});
