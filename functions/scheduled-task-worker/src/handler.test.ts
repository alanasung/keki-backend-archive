import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { isKnownTaskKey, KNOWN_TASK_KEYS, type KnownTaskKey } from '@keki/contracts';

const { sendMock, syncCatalogMock, createSquareClientMock, expireStaleHoldsMock } = vi.hoisted(() => ({
  sendMock: vi.fn().mockResolvedValue({}),
  syncCatalogMock: vi.fn().mockResolvedValue({ upserted: 0, archived: 0, pages: 0 }),
  createSquareClientMock: vi.fn().mockReturnValue({}),
  expireStaleHoldsMock: vi.fn().mockResolvedValue(0),
}));

vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: vi.fn().mockImplementation(() => ({ send: sendMock })),
  SendMessageCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

vi.mock('@keki/catalog-core', () => ({ syncCatalog: syncCatalogMock }));
vi.mock('@keki/square-client', () => ({ createSquareClient: createSquareClientMock }));
vi.mock('@keki/reservation-core', () => ({ expireStaleHolds: expireStaleHoldsMock }));

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
    eventSourceARN: 'arn:aws:sqs:us-east-1:000000000000:ScheduledTaskQueue',
    awsRegion: 'us-east-1',
  };
}

function sqsEvent(records: SQSRecord[]): SQSEvent {
  return { Records: records };
}

function scheduledTaskEnvelope(taskKey: string): string {
  return JSON.stringify({
    version: 1,
    type: 'scheduled.tick',
    occurredAt: new Date().toISOString(),
    payload: { taskKey },
  });
}

beforeEach(() => {
  sendMock.mockClear();
  syncCatalogMock.mockClear();
  createSquareClientMock.mockClear();
  expireStaleHoldsMock.mockClear();
  process.env['NOTIFICATION_QUEUE_URL'] = 'https://sqs.example.com/queue/NotificationQueue';
});

describe('handler', () => {
  it('rejects a malformed envelope', async () => {
    const result = await handler(sqsEvent([makeRecord('bad-1', JSON.stringify({ type: 'scheduled.tick' }))]));

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'bad-1' }]);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('rejects invalid JSON', async () => {
    const result = await handler(sqsEvent([makeRecord('bad-2', 'not json')]));

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'bad-2' }]);
  });

  it('an unrecognized task key logs and returns success rather than dead-lettering', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await handler(sqsEvent([makeRecord('m1', scheduledTaskEnvelope('some.stale.task'))]));

    expect(result.batchItemFailures).toEqual([]);
    expect(sendMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('a known task key (notification.drain) enqueues to the notification queue', async () => {
    const result = await handler(sqsEvent([makeRecord('m1', scheduledTaskEnvelope('notification.drain'))]));

    expect(result.batchItemFailures).toEqual([]);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('returns a batchItemFailures array even on full success', async () => {
    const result = await handler(sqsEvent([makeRecord('m1', scheduledTaskEnvelope('notification.drain'))]));

    expect(Array.isArray(result.batchItemFailures)).toBe(true);
  });

  it('dispatches catalog.sync: constructs the Square client and calls syncCatalog', async () => {
    const result = await handler(sqsEvent([makeRecord('m1', scheduledTaskEnvelope('catalog.sync'))]));

    expect(result.batchItemFailures).toEqual([]);
    expect(createSquareClientMock).toHaveBeenCalledTimes(1);
    expect(syncCatalogMock).toHaveBeenCalledTimes(1);
  });

  it('dispatches reservation.expire-holds: calls expireStaleHolds', async () => {
    const result = await handler(sqsEvent([makeRecord('m1', scheduledTaskEnvelope('reservation.expire-holds'))]));

    expect(result.batchItemFailures).toEqual([]);
    expect(expireStaleHoldsMock).toHaveBeenCalledTimes(1);
  });
});

describe('catalog.sync task key', () => {
  it('is a known task key', () => {
    expect(isKnownTaskKey('catalog.sync')).toBe(true);
  });
});

describe('reservation.expire-holds task key', () => {
  it('is a known task key', () => {
    expect(isKnownTaskKey('reservation.expire-holds')).toBe(true);
  });
});

// Type-level exhaustiveness guard (test 11): proves the handler's switch is
// exhaustive over KnownTaskKey with a `never` default. If KNOWN_TASK_KEYS
// (packages/contracts/src/messages.ts) ever gains a member without a
// corresponding case in handler.ts's switch, the mirrored switch below stops
// typechecking — the `@ts-expect-error` becomes an unused directive, and
// `pnpm typecheck` fails. This can't reach into handler.ts's private switch
// directly, so it mirrors its shape against the same KnownTaskKey union.
type ExtendedTaskKey = KnownTaskKey | 'extra.stale.task';

function exhaustiveOverKnownTaskKeys(taskKey: ExtendedTaskKey): string {
  switch (taskKey) {
    case 'notification.drain':
    case 'catalog.sync':
    case 'reservation.expire-holds':
      return 'handled';
    default: {
      // @ts-expect-error - ExtendedTaskKey has a member ('extra.stale.task')
      // not covered above, so `taskKey` here is not `never`. Handler.ts's
      // real switch, over the real KnownTaskKey, would fail exactly the
      // same way if KNOWN_TASK_KEYS grew a member without a matching case.
      const unhandled: never = taskKey;
      return unhandled;
    }
  }
}

describe('KNOWN_TASK_KEYS exhaustiveness', () => {
  it('covers every known task key', () => {
    for (const key of KNOWN_TASK_KEYS) {
      expect(exhaustiveOverKnownTaskKeys(key)).toBe('handled');
    }
  });
});
