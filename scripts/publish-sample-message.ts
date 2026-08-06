import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { eq } from 'drizzle-orm';
import { db, notificationOutbox } from '@keki/database';
import type { NotificationMessage } from '@keki/contracts';
import { enqueueNotification } from '@keki/notification-core';

// The executable proof of SC-08: "a message published to SQS is consumed by
// its deployed worker." A deployment alone does not demonstrate consumption
// — this script seeds a real notification_outbox row, publishes the same
// notification.drain message the scheduled-task-worker would, and polls
// until the deployed notification-worker actually claims, dispatches, and
// settles it. Exits non-zero on timeout so it can gate a deploy in CI.
//
// Run against a deployed stage with NOTIFICATION_QUEUE_URL,
// DATABASE_URL_POOLED, and DATABASE_URL_DIRECT set (e.g. via `sst shell`, or
// exported from that stage's outputs) and valid AWS credentials for the SQS
// SendMessage call.

const POLL_INTERVAL_MS = 2000;
const TIMEOUT_MS = 60_000;

function getQueueUrl(): string {
  const url = process.env['NOTIFICATION_QUEUE_URL'];
  if (url === undefined || url === '') {
    throw new Error('publish-sample-message: NOTIFICATION_QUEUE_URL is not configured.');
  }
  return url;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const sqsClient = new SQSClient({});
  const marker = randomUUID();

  console.log(`publish-sample-message: seeding a notification_outbox row (marker ${marker})...`);
  const entry = await enqueueNotification({
    channel: 'EMAIL',
    templateKey: 'sc-08-round-trip',
    recipientAddress: `sc-08-round-trip+${marker}@example.com`,
    payload: { marker },
  });
  console.log(`publish-sample-message: seeded row ${entry.id} (status ${entry.status}).`);

  const message: NotificationMessage = {
    version: 1,
    type: 'notification.drain',
    occurredAt: new Date().toISOString(),
    payload: {},
  };

  console.log('publish-sample-message: publishing notification.drain to NotificationQueue...');
  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: getQueueUrl(),
      MessageBody: JSON.stringify(message),
    }),
  );

  console.log(`publish-sample-message: polling for row ${entry.id} to reach SENT (timeout ${TIMEOUT_MS}ms)...`);
  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    const rows = await db.select().from(notificationOutbox).where(eq(notificationOutbox.id, entry.id)).limit(1);
    const row = rows[0];

    if (row?.status === 'SENT') {
      console.log(`publish-sample-message: row ${entry.id} reached SENT — SC-08 round trip confirmed.`);
      return;
    }
    if (row?.status === 'DEAD') {
      throw new Error(
        `publish-sample-message: row ${entry.id} reached DEAD instead of SENT: ${row.lastError ?? 'no error recorded'}`,
      );
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(
    `publish-sample-message: timed out after ${TIMEOUT_MS}ms waiting for row ${entry.id} to reach SENT.`,
  );
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error: unknown) => {
    console.error('publish-sample-message: failed.', error);
    process.exitCode = 1;
  });
