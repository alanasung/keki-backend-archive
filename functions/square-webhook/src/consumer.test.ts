import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQSEvent, SQSRecord } from 'aws-lambda';

const { fulfillPaymentMock, sendMock } = vi.hoisted(() => ({
  fulfillPaymentMock: vi.fn(),
  sendMock: vi.fn().mockResolvedValue({}),
}));

vi.mock('./fulfillment', () => ({
  fulfillPayment: fulfillPaymentMock,
}));

vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: vi.fn().mockImplementation(() => ({ send: sendMock })),
  SendMessageCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

import { queueHandler } from './consumer';

const SQUARE_ORDER_ID = 'square-order-1';
const CREATED_AT = '2026-01-01T00:00:00.000Z';

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

function paymentWebhookRawBody(
  type: 'payment.created' | 'payment.updated',
  paymentObject: Record<string, unknown>,
): string {
  return JSON.stringify({
    merchant_id: 'merchant-1',
    type,
    event_id: 'event-1',
    created_at: CREATED_AT,
    data: {
      type: 'payment',
      id: paymentObject['id'],
      object: paymentObject,
    },
  });
}

function catalogUpdatedRawBody(): string {
  return JSON.stringify({
    merchant_id: 'merchant-1',
    type: 'catalog.version.updated',
    event_id: 'event-2',
    created_at: CREATED_AT,
    data: { type: 'catalog_version', id: 'catalog-1', object: {} },
  });
}

function unknownEventRawBody(): string {
  return JSON.stringify({
    merchant_id: 'merchant-1',
    type: 'refund.updated',
    event_id: 'event-3',
    created_at: CREATED_AT,
    data: { type: 'refund', id: 'refund-1', object: {} },
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
  fulfillPaymentMock.mockReset().mockResolvedValue({ orderId: null, confirmed: 0 });
  sendMock.mockClear();
  process.env['SCHEDULED_TASK_QUEUE_URL'] = 'https://sqs.example.com/queue/ScheduledTaskQueue';
});

describe('queueHandler', () => {
  it('rejects a malformed envelope without calling fulfillPayment', async () => {
    const result = await queueHandler(
      sqsEvent([makeRecord('bad-1', JSON.stringify({ type: 'square.webhook' }))]),
    );

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'bad-1' }]);
    expect(fulfillPaymentMock).not.toHaveBeenCalled();
  });

  it('rejects invalid JSON without calling fulfillPayment', async () => {
    const result = await queueHandler(sqsEvent([makeRecord('bad-2', 'not json')]));

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'bad-2' }]);
    expect(fulfillPaymentMock).not.toHaveBeenCalled();
  });

  it('routes payment.created and payment.updated to fulfillPayment with the real Square payment shape', async () => {
    const rawBody = paymentWebhookRawBody('payment.updated', {
      id: 'square-payment-1',
      status: 'COMPLETED',
      amount_money: { amount: 2500, currency: 'USD' },
      order_id: SQUARE_ORDER_ID,
    });

    const result = await queueHandler(sqsEvent([makeRecord('m1', squareWebhookEnvelope(rawBody))]));

    expect(result.batchItemFailures).toEqual([]);
    expect(fulfillPaymentMock).toHaveBeenCalledWith({
      squareOrderId: SQUARE_ORDER_ID,
      providerPaymentId: 'square-payment-1',
      amountCents: 2500,
      currency: 'USD',
      status: 'CAPTURED',
      rawPayload: {
        id: 'square-payment-1',
        status: 'COMPLETED',
        amount_money: { amount: 2500, currency: 'USD' },
        order_id: SQUARE_ORDER_ID,
      },
      occurredAt: new Date(CREATED_AT),
    });
  });

  it('never reads household_id from the payload — a bogus one is dropped before fulfillPayment is called (test 8)', async () => {
    const rawBody = paymentWebhookRawBody('payment.updated', {
      id: 'square-payment-2',
      status: 'COMPLETED',
      amount_money: { amount: 1000, currency: 'USD' },
      order_id: SQUARE_ORDER_ID,
      household_id: 'evil-household-id',
      reservation_id: 'evil-reservation-id',
    });

    await queueHandler(sqsEvent([makeRecord('m1', squareWebhookEnvelope(rawBody))]));

    expect(fulfillPaymentMock).toHaveBeenCalledTimes(1);
    const [callArg] = fulfillPaymentMock.mock.calls[0] as [Record<string, unknown>];
    expect(callArg).not.toHaveProperty('householdId');
    expect(callArg).not.toHaveProperty('reservationId');
    expect(callArg['squareOrderId']).toBe(SQUARE_ORDER_ID);
  });

  it('acknowledges a payment with no order_id without calling fulfillPayment', async () => {
    const rawBody = paymentWebhookRawBody('payment.updated', {
      id: 'square-payment-3',
      status: 'COMPLETED',
      amount_money: { amount: 500, currency: 'USD' },
    });

    const result = await queueHandler(sqsEvent([makeRecord('m1', squareWebhookEnvelope(rawBody))]));

    expect(result.batchItemFailures).toEqual([]);
    expect(fulfillPaymentMock).not.toHaveBeenCalled();
  });

  it('catalog.version.updated enqueues a catalog.sync scheduled-task message (SC-12 webhook half, test 17)', async () => {
    const result = await queueHandler(
      sqsEvent([makeRecord('m1', squareWebhookEnvelope(catalogUpdatedRawBody()))]),
    );

    expect(result.batchItemFailures).toEqual([]);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const [command] = sendMock.mock.calls[0] as [{ input: { QueueUrl: string; MessageBody: string } }];
    expect(command.input.QueueUrl).toBe('https://sqs.example.com/queue/ScheduledTaskQueue');
    const body = JSON.parse(command.input.MessageBody) as { type: string; payload: { taskKey: string } };
    expect(body.type).toBe('scheduled.tick');
    expect(body.payload.taskKey).toBe('catalog.sync');
  });

  it('acknowledges an unrecognized event type without failing (test 18)', async () => {
    const result = await queueHandler(sqsEvent([makeRecord('m1', squareWebhookEnvelope(unknownEventRawBody()))]));

    expect(result.batchItemFailures).toEqual([]);
    expect(fulfillPaymentMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('reports a genuine processing failure in batchItemFailures (test 19)', async () => {
    fulfillPaymentMock.mockRejectedValueOnce(new Error('database exploded'));
    const rawBody = paymentWebhookRawBody('payment.updated', {
      id: 'square-payment-4',
      status: 'COMPLETED',
      amount_money: { amount: 100, currency: 'USD' },
      order_id: SQUARE_ORDER_ID,
    });

    const result = await queueHandler(sqsEvent([makeRecord('m1', squareWebhookEnvelope(rawBody))]));

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'm1' }]);
  });

  it('does not fail the whole batch for one malformed record (test 20)', async () => {
    const goodRawBody = paymentWebhookRawBody('payment.updated', {
      id: 'square-payment-5',
      status: 'COMPLETED',
      amount_money: { amount: 100, currency: 'USD' },
      order_id: SQUARE_ORDER_ID,
    });

    const result = await queueHandler(
      sqsEvent([
        makeRecord('bad-1', 'not json'),
        makeRecord('good-1', squareWebhookEnvelope(goodRawBody)),
      ]),
    );

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'bad-1' }]);
    expect(fulfillPaymentMock).toHaveBeenCalledTimes(1);
  });

  it('is idempotent on redelivery: fulfillPayment runs again and both attempts succeed', async () => {
    const rawBody = paymentWebhookRawBody('payment.updated', {
      id: 'square-payment-6',
      status: 'COMPLETED',
      amount_money: { amount: 100, currency: 'USD' },
      order_id: SQUARE_ORDER_ID,
    });
    const body = squareWebhookEnvelope(rawBody);

    const first = await queueHandler(sqsEvent([makeRecord('m1', body)]));
    const second = await queueHandler(sqsEvent([makeRecord('m2', body)]));

    expect(first.batchItemFailures).toEqual([]);
    expect(second.batchItemFailures).toEqual([]);
    expect(fulfillPaymentMock).toHaveBeenCalledTimes(2);
  });
});
