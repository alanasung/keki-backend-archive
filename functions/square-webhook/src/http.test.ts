import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn().mockResolvedValue({}) }));

vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: vi.fn().mockImplementation(() => ({ send: sendMock })),
  SendMessageCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

import { httpHandler } from './http';

const SIGNING_KEY = 'test-signing-key';
const NOTIFICATION_URL = 'https://example.com/webhooks/square';

function signBody(rawBody: string, notificationUrl = NOTIFICATION_URL, signingKey = SIGNING_KEY): string {
  return createHmac('sha256', signingKey).update(notificationUrl + rawBody, 'utf8').digest('base64');
}

beforeEach(() => {
  sendMock.mockClear();
  process.env['SQUARE_WEBHOOK_SIGNATURE_KEY'] = SIGNING_KEY;
  process.env['SQUARE_WEBHOOK_QUEUE_URL'] = 'https://sqs.example.com/queue/SquareWebhookQueue';
  process.env['SQUARE_NOTIFICATION_URL'] = NOTIFICATION_URL;
});

describe('httpHandler', () => {
  it('accepts a valid signature, wraps and enqueues the envelope, and returns 200 (test 1)', async () => {
    const rawBody = JSON.stringify({ hello: 'world' });
    const signature = signBody(rawBody);

    const result = await httpHandler({
      headers: { 'x-square-signature': signature },
      body: rawBody,
      isBase64Encoded: false,
    });

    expect(result.statusCode).toBe(200);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid signature with 401 and never enqueues (test 2)', async () => {
    const result = await httpHandler({
      headers: { 'x-square-signature': 'not-a-real-signature' },
      body: JSON.stringify({ hello: 'world' }),
      isBase64Encoded: false,
    });

    expect(result.statusCode).toBe(401);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('rejects a request missing the signature header (test 3)', async () => {
    const result = await httpHandler({
      headers: {},
      body: JSON.stringify({ hello: 'world' }),
      isBase64Encoded: false,
    });

    expect(result.statusCode).toBe(401);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('rejects a signature computed for a different notification URL, proving the real verifier is wired in (test 4)', async () => {
    const rawBody = JSON.stringify({ hello: 'world' });
    // Signed for a URL other than the one SQUARE_NOTIFICATION_URL resolves
    // to below — the Phase 1 HMAC never checked the URL at all, so this
    // would have passed under the old verifier.
    const signature = signBody(rawBody, 'https://example.com/webhooks/OTHER');

    const result = await httpHandler({
      headers: { 'x-square-signature': signature },
      body: rawBody,
      isBase64Encoded: false,
    });

    expect(result.statusCode).toBe(401);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('throws when SQUARE_NOTIFICATION_URL is not configured, matching existing getter behavior (test 5)', async () => {
    delete process.env['SQUARE_NOTIFICATION_URL'];
    const rawBody = JSON.stringify({ hello: 'world' });
    const signature = signBody(rawBody);

    await expect(
      httpHandler({
        headers: { 'x-square-signature': signature },
        body: rawBody,
        isBase64Encoded: false,
      }),
    ).rejects.toThrow('SQUARE_NOTIFICATION_URL is not configured');
  });

  it('does not parse the body before verifying the signature', async () => {
    const parseSpy = vi.spyOn(JSON, 'parse');

    await httpHandler({
      headers: { 'x-square-signature': 'not-a-real-signature' },
      body: JSON.stringify({ hello: 'world' }),
      isBase64Encoded: false,
    });

    expect(parseSpy).not.toHaveBeenCalled();
    parseSpy.mockRestore();
  });

  it('verifies a base64-encoded body correctly', async () => {
    const rawBody = JSON.stringify({ hello: 'base64' });
    const signature = signBody(rawBody);

    const result = await httpHandler({
      headers: { 'x-square-signature': signature },
      body: Buffer.from(rawBody, 'utf8').toString('base64'),
      isBase64Encoded: true,
    });

    expect(result.statusCode).toBe(200);
  });
});

describe('the Phase 1 verifier is gone (test 6)', () => {
  it('deletes src/verify-signature.ts', () => {
    expect(existsSync(new URL('./verify-signature.ts', import.meta.url))).toBe(false);
  });

  it('http.ts imports the real verifier from @keki/square-client, not a local module', () => {
    const source = readFileSync(new URL('./http.ts', import.meta.url), 'utf8');

    expect(source).toContain("from '@keki/square-client'");
    expect(source).not.toContain("from './verify-signature'");
  });
});
