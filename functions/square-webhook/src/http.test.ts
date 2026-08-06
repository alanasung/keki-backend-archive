import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn().mockResolvedValue({}) }));

vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: vi.fn().mockImplementation(() => ({ send: sendMock })),
  SendMessageCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

import { httpHandler } from './http';

const SIGNING_KEY = 'test-signing-key';

function signBody(rawBody: string): string {
  return createHmac('sha256', SIGNING_KEY).update(rawBody, 'utf8').digest('base64');
}

beforeEach(() => {
  sendMock.mockClear();
  process.env['SQUARE_WEBHOOK_SIGNATURE_KEY'] = SIGNING_KEY;
  process.env['SQUARE_WEBHOOK_QUEUE_URL'] = 'https://sqs.example.com/queue/SquareWebhookQueue';
});

describe('httpHandler', () => {
  it('rejects an invalid signature with 401 and never enqueues (so recordPaymentFromWebhook is never reached)', async () => {
    const result = await httpHandler({
      headers: { 'x-square-signature': 'not-a-real-signature' },
      body: JSON.stringify({ hello: 'world' }),
      isBase64Encoded: false,
    });

    expect(result.statusCode).toBe(401);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('rejects a request missing the signature header', async () => {
    const result = await httpHandler({
      headers: {},
      body: JSON.stringify({ hello: 'world' }),
      isBase64Encoded: false,
    });

    expect(result.statusCode).toBe(401);
    expect(sendMock).not.toHaveBeenCalled();
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

  it('accepts a valid signature, wraps and enqueues the envelope, and returns 200', async () => {
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

describe('verify-signature', () => {
  it('uses crypto.timingSafeEqual and contains no === comparison of signature bytes', () => {
    const source = readFileSync(new URL('./verify-signature.ts', import.meta.url), 'utf8');

    expect(source).toContain('timingSafeEqual(');
    // Not a bare `.not.toContain('===')` — the file's own doc comment
    // legitimately mentions `===` in prose to explain why it's avoided.
    // This checks for an actual comparison of the signature-related
    // identifiers instead.
    expect(source).not.toMatch(/(expected|provided|signature)\s*===/);
  });
});
