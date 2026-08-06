import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { isKnownTaskKey, scheduledTaskMessageSchema, type NotificationMessage } from '@keki/contracts';

const sqsClient = new SQSClient({});

function getNotificationQueueUrl(): string {
  const url = process.env['NOTIFICATION_QUEUE_URL'];
  if (url === undefined || url === '') {
    throw new Error('scheduled-task-worker: NOTIFICATION_QUEUE_URL is not configured.');
  }
  return url;
}

async function enqueueNotificationDrain(): Promise<void> {
  const message: NotificationMessage = {
    version: 1,
    type: 'notification.drain',
    occurredAt: new Date().toISOString(),
    payload: {},
  };

  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: getNotificationQueueUrl(),
      MessageBody: JSON.stringify(message),
    }),
  );
}

// The EventBridge Scheduler role from WS-10's real target. Scheduling policy
// (which tasks run when) stays in Phase 2 — this handler just narrows a
// known task key to a real action.
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      const message = scheduledTaskMessageSchema.parse(JSON.parse(record.body));
      const { taskKey } = message.payload;

      // An unrecognized key from a stale schedule must not fill the DLQ —
      // log and return success rather than adding it to batchItemFailures.
      if (!isKnownTaskKey(taskKey)) {
        console.warn(`scheduled-task-worker: unrecognized task key "${taskKey}"; skipping.`);
        continue;
      }

      switch (taskKey) {
        case 'notification.drain':
          await enqueueNotificationDrain();
          break;
        default: {
          const unhandled: never = taskKey;
          throw new Error(`scheduled-task-worker: unhandled known task key "${String(unhandled)}".`);
        }
      }
    } catch (error) {
      console.error('scheduled-task-worker: failed to process message', error);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}
