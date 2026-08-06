import { describe, expect, it, vi } from 'vitest';
import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { handler } from './handler';

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
    eventSourceARN: 'arn:aws:sqs:us-east-1:000000000000:ReconciliationQueue',
    awsRegion: 'us-east-1',
  };
}

function sqsEvent(records: SQSRecord[]): SQSEvent {
  return { Records: records };
}

function reconciliationEnvelope(payload: { since?: string } = {}): string {
  return JSON.stringify({
    version: 1,
    type: 'reconciliation.run',
    occurredAt: new Date().toISOString(),
    payload,
  });
}

describe('handler', () => {
  it('rejects a malformed envelope', async () => {
    const result = await handler(sqsEvent([makeRecord('bad-1', JSON.stringify({ type: 'reconciliation.run' }))]));

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'bad-1' }]);
  });

  it('rejects invalid JSON', async () => {
    const result = await handler(sqsEvent([makeRecord('bad-2', 'not json')]));

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'bad-2' }]);
  });

  it('accepts a valid envelope, logs the requested window, and returns an empty batch-failure list', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const result = await handler(sqsEvent([makeRecord('m1', reconciliationEnvelope({ since: '2026-01-01T00:00:00.000Z' }))]));

    expect(result.batchItemFailures).toEqual([]);
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('returns a batchItemFailures array even on full success', async () => {
    const result = await handler(sqsEvent([makeRecord('m1', reconciliationEnvelope())]));

    expect(Array.isArray(result.batchItemFailures)).toBe(true);
  });
});
