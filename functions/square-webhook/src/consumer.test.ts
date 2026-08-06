import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQSEvent, SQSRecord } from 'aws-lambda';

const { recordPaymentFromWebhookMock } = vi.hoisted(() => ({
  recordPaymentFromWebhookMock: vi.fn(),
}));

vi.mock('@keki/commerce-core', () => ({
  recordPaymentFromWebhook: recordPaymentFromWebhookMock,
}));

import { queueHandler } from './consumer';

const HOUSEHOLD_ID = '11111111-1111-4111-8111-111111111111';

function makeRecord(messageId: string, body: string): SQSRecord {
  return {
    messageId,
    receiptHandle: `receipt-${messageId}`,
    body,
    attributes: {
      ApproximateReceiveCount: '1',
      SentTimestamp: '0',
      SenderId: 'test-sender',
      ApproximateFirstReceiveTimestamp: '0',
    },
    messageAttributes: {},
    md5OfBody: 'test-md5',
    eventSource: 'aws:sqs',
    eventSourceARN: 'arn:aws:sqs:us-east-1:000000000000:SquareWebhookQueue',
    awsRegion: 'us-east-1',
  };
}

function sqsEvent(records: SQSRecord[]): SQSEvent {
  return { Records: records };
}

function squareWebhookRawBody(paymentId: string): string {
  return JSON.stringify({
    merchant_id: 'merchant-1',
    type: 'payment.updated',
    event_id: 'event-1',
    created_at: '2026-01-01T00:00:00.000Z',
    data: {
      type: 'payment',
      id: paymentId,
      object: {
        id: paymentId,
        status: 'CAPTURED',
        amount_money: { amount: 2500, currency: 'USD' },
        household_id: HOUSEHOLD_ID,
      },
    },
  });
}

function squareWebhookEnvelope(rawBody: string): string {
  return JSON.stringify({
    version: 1,
    type: 'square.webhook',
    occurredAt: new Date().toISOString(),
    payload: {
      rawBody,
      headers: {},
      verifiedAt: new Date().toISOString(),
    },
  });
}

beforeEach(() => {
  recordPaymentFromWebhookMock.mockReset();
});

describe('queueHandler', () => {
  it('rejects a malformed envelope without calling recordPaymentFromWebhook', async () => {
    const result = await queueHandler(
      sqsEvent([makeRecord('bad-1', JSON.stringify({ type: 'square.webhook' }))]),
    );

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'bad-1' }]);
    expect(recordPaymentFromWebhookMock).not.toHaveBeenCalled();
  });

  it('rejects invalid JSON without calling recordPaymentFromWebhook', async () => {
    const result = await queueHandler(sqsEvent([makeRecord('bad-2', 'not json')]));

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'bad-2' }]);
    expect(recordPaymentFromWebhookMock).not.toHaveBeenCalled();
  });

  it('is idempotent on redelivery: created:true then created:false, succeeding both times', async () => {
    recordPaymentFromWebhookMock
      .mockResolvedValueOnce({
        created: true,
        record: { id: 'payment-record-1', providerPaymentId: 'square-payment-1' },
      })
      .mockResolvedValueOnce({
        created: false,
        record: { id: 'payment-record-1', providerPaymentId: 'square-payment-1' },
      });

    const rawBody = squareWebhookRawBody('square-payment-1');
    const body = squareWebhookEnvelope(rawBody);

    const first = await queueHandler(sqsEvent([makeRecord('m1', body)]));
    const second = await queueHandler(sqsEvent([makeRecord('m2', body)]));

    expect(first.batchItemFailures).toEqual([]);
    expect(second.batchItemFailures).toEqual([]);
    expect(recordPaymentFromWebhookMock).toHaveBeenCalledTimes(2);
    expect(recordPaymentFromWebhookMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ providerPaymentId: 'square-payment-1' }),
    );
    expect(recordPaymentFromWebhookMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ providerPaymentId: 'square-payment-1' }),
    );
  });

  it('returns a batchItemFailures array even on full success', async () => {
    recordPaymentFromWebhookMock.mockResolvedValue({
      created: true,
      record: { id: 'payment-record-1', providerPaymentId: 'square-payment-2' },
    });

    const body = squareWebhookEnvelope(squareWebhookRawBody('square-payment-2'));
    const result = await queueHandler(sqsEvent([makeRecord('m1', body)]));

    expect(Array.isArray(result.batchItemFailures)).toBe(true);
    expect(result.batchItemFailures).toEqual([]);
  });
});
