import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context, SQSEvent, SQSRecord } from 'aws-lambda';

// vi.mock factories are hoisted above all other top-level code, so mock state
// must be created via vi.hoisted() — see packages/auth/src/profile.test.ts
// for the same pattern.
const {
  reclaimStaleClaimsMock,
  claimDueNotificationsMock,
  dispatchNotificationMock,
  markNotificationSentMock,
  markNotificationFailedMock,
  createNoopProvidersMock,
} = vi.hoisted(() => ({
  reclaimStaleClaimsMock: vi.fn(() => Promise.resolve(0)),
  claimDueNotificationsMock: vi.fn(() => Promise.resolve([] as Array<{ id: string }>)),
  dispatchNotificationMock: vi.fn(() => Promise.resolve({ providerMessageId: 'noop-1' })),
  markNotificationSentMock: vi.fn(() => Promise.resolve(undefined)),
  markNotificationFailedMock: vi.fn(() => Promise.resolve(undefined)),
  createNoopProvidersMock: vi.fn(() => ({
    email: { send: vi.fn() },
    sms: { send: vi.fn() },
    marketing: { identify: vi.fn(), track: vi.fn(), subscribe: vi.fn(), send: vi.fn() },
  })),
}));

vi.mock('@keki/notification-core', () => ({
  reclaimStaleClaims: reclaimStaleClaimsMock,
  claimDueNotifications: claimDueNotificationsMock,
  dispatchNotification: dispatchNotificationMock,
  markNotificationSent: markNotificationSentMock,
  markNotificationFailed: markNotificationFailedMock,
  createNoopProviders: createNoopProvidersMock,
}));

// Real module: eager createNoopProviders() runs at import time (see
// handler.ts), which is fine here — NODE_ENV is 'test', so the production
// guard never trips. Its behavior under NODE_ENV=production is covered
// separately in handler.production-guard.test.ts, which must NOT mock
// @keki/notification-core so it exercises the real guard.
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
    eventSourceARN: 'arn:aws:sqs:us-east-1:000000000000:NotificationQueue',
    awsRegion: 'us-east-1',
  };
}

function sqsEvent(records: SQSRecord[]): SQSEvent {
  return { Records: records };
}

function notificationEnvelope(payload: { limit?: number } = {}): string {
  return JSON.stringify({
    version: 1,
    type: 'notification.drain',
    occurredAt: new Date().toISOString(),
    payload,
  });
}

const fakeContext = { awsRequestId: 'test-request-id' } as unknown as Context;

beforeEach(() => {
  reclaimStaleClaimsMock.mockReset().mockResolvedValue(0);
  claimDueNotificationsMock.mockReset().mockResolvedValue([]);
  dispatchNotificationMock.mockReset().mockResolvedValue({ providerMessageId: 'noop-1' });
  markNotificationSentMock.mockReset().mockResolvedValue(undefined);
  markNotificationFailedMock.mockReset().mockResolvedValue(undefined);
});

describe('handler', () => {
  it('rejects a malformed envelope without calling any domain function', async () => {
    const result = await handler(
      sqsEvent([makeRecord('bad-1', JSON.stringify({ type: 'notification.drain' }))]),
      fakeContext,
    );

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'bad-1' }]);
    expect(claimDueNotificationsMock).not.toHaveBeenCalled();
    expect(dispatchNotificationMock).not.toHaveBeenCalled();
  });

  it('rejects invalid JSON without calling any domain function', async () => {
    const result = await handler(sqsEvent([makeRecord('bad-2', '{not json')]), fakeContext);

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'bad-2' }]);
    expect(claimDueNotificationsMock).not.toHaveBeenCalled();
  });

  it('reclaims stale claims before claiming, on every invocation', async () => {
    const callOrder: string[] = [];
    reclaimStaleClaimsMock.mockImplementation(() => {
      callOrder.push('reclaim');
      return Promise.resolve(0);
    });
    claimDueNotificationsMock.mockImplementation(() => {
      callOrder.push('claim');
      return Promise.resolve([]);
    });

    await handler(sqsEvent([makeRecord('m1', notificationEnvelope())]), fakeContext);

    expect(reclaimStaleClaimsMock).toHaveBeenCalledTimes(1);
    expect(callOrder[0]).toBe('reclaim');
    expect(callOrder.indexOf('reclaim')).toBeLessThan(callOrder.indexOf('claim'));
  });

  it('dispatches every claimed entry and marks each sent', async () => {
    const entries = [{ id: 'n1' }, { id: 'n2' }, { id: 'n3' }];
    claimDueNotificationsMock.mockResolvedValue(entries);

    await handler(sqsEvent([makeRecord('m1', notificationEnvelope())]), fakeContext);

    expect(dispatchNotificationMock).toHaveBeenCalledTimes(3);
    expect(markNotificationSentMock).toHaveBeenCalledTimes(3);
  });

  it('a single dispatch failure does not fail the batch, and records the error', async () => {
    const entries = [{ id: 'n1' }, { id: 'n2' }, { id: 'n3' }];
    claimDueNotificationsMock.mockResolvedValue(entries);
    dispatchNotificationMock
      .mockResolvedValueOnce({ providerMessageId: 'ok-1' })
      .mockRejectedValueOnce(new Error('provider exploded'))
      .mockResolvedValueOnce({ providerMessageId: 'ok-3' });

    const result = await handler(sqsEvent([makeRecord('m1', notificationEnvelope())]), fakeContext);

    expect(result.batchItemFailures).toEqual([]);
    expect(markNotificationSentMock).toHaveBeenCalledTimes(2);
    expect(markNotificationSentMock).toHaveBeenCalledWith({ id: 'n1' });
    expect(markNotificationSentMock).toHaveBeenCalledWith({ id: 'n3' });
    expect(markNotificationFailedMock).toHaveBeenCalledTimes(1);
    expect(markNotificationFailedMock).toHaveBeenCalledWith({ id: 'n2', error: 'provider exploded' });
  });

  it('reports batchItemFailures accurately when only the first of two messages fails to claim', async () => {
    claimDueNotificationsMock.mockRejectedValueOnce(new Error('claim exploded')).mockResolvedValueOnce([]);

    const result = await handler(
      sqsEvent([makeRecord('m1', notificationEnvelope()), makeRecord('m2', notificationEnvelope())]),
      fakeContext,
    );

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'm1' }]);
  });

  it('returns a batchItemFailures array even on full success', async () => {
    const result = await handler(sqsEvent([makeRecord('m1', notificationEnvelope())]), fakeContext);

    expect(Array.isArray(result.batchItemFailures)).toBe(true);
    expect(result.batchItemFailures).toEqual([]);
  });
});
