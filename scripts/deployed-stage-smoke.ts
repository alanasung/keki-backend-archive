import 'dotenv/config';
import {
  GetQueueAttributesCommand,
  ListQueuesCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { ReconciliationMessage } from '@keki/contracts';

// Post-deploy smoke test: proves the SQS -> Lambda wiring of a deployed
// stage by publishing a reconciliation.run message and watching the
// ReconciliationQueue drain without the DLQ growing.
//
// The ReconciliationQueue is chosen deliberately over the NotificationQueue
// that scripts/publish-sample-message.ts exercises: its worker is a
// validated skeleton that consumes and succeeds without touching the
// database or dispatching anything, so this is safe to run against
// production on every deploy. publish-sample-message.ts remains the fuller
// SC-08 proof for non-production stages (in production the notification
// worker refuses no-op providers by design — see
// packages/notification-core/src/providers.ts).
//
// Run with KEKI_STAGE set and AWS credentials for the target account.
// Queue URLs are resolved by name prefix (`keki-{stage}-ReconciliationQueue`,
// the physical naming SST applies — see docs/aws-iam-request.md "On
// scoping"); set RECONCILIATION_QUEUE_URL to override.

const POLL_INTERVAL_MS = 3000;
const TIMEOUT_MS = 120_000;
const CONSECUTIVE_EMPTY_REQUIRED = 2;

function getStage(): string {
  const stage = process.env['KEKI_STAGE'];
  if (stage === undefined || stage === '') {
    throw new Error('deployed-stage-smoke: KEKI_STAGE is not configured.');
  }
  return stage;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveQueueUrls(
  sqsClient: SQSClient,
  stage: string,
): Promise<{ queueUrl: string; dlqUrl: string }> {
  const override = process.env['RECONCILIATION_QUEUE_URL'];
  const prefix = `keki-${stage}-ReconciliationQueue`;

  const listed = await sqsClient.send(new ListQueuesCommand({ QueueNamePrefix: prefix }));
  const urls = listed.QueueUrls ?? [];
  const queueUrls = urls.filter((url) => !url.includes('DLQ'));
  const dlqUrls = urls.filter((url) => url.includes('DLQ'));

  const queueUrl = override !== undefined && override !== '' ? override : queueUrls[0];
  const dlqUrl = dlqUrls[0];

  if (queueUrl === undefined || dlqUrl === undefined || queueUrls.length > 1 || dlqUrls.length > 1) {
    throw new Error(
      `deployed-stage-smoke: could not resolve exactly one queue and one DLQ for prefix "${prefix}". ` +
        `Found: [${urls.join(', ')}]. Is the "${stage}" stage deployed?`,
    );
  }

  return { queueUrl, dlqUrl };
}

async function messageCounts(
  sqsClient: SQSClient,
  queueUrl: string,
): Promise<{ total: number; visible: number }> {
  const attributes = await sqsClient.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: [
        'ApproximateNumberOfMessages',
        'ApproximateNumberOfMessagesNotVisible',
        'ApproximateNumberOfMessagesDelayed',
      ],
    }),
  );
  const visible = Number(attributes.Attributes?.['ApproximateNumberOfMessages'] ?? '0');
  const notVisible = Number(attributes.Attributes?.['ApproximateNumberOfMessagesNotVisible'] ?? '0');
  const delayed = Number(attributes.Attributes?.['ApproximateNumberOfMessagesDelayed'] ?? '0');
  return { total: visible + notVisible + delayed, visible };
}

async function main(): Promise<void> {
  const stage = getStage();
  const sqsClient = new SQSClient({});

  console.log(`deployed-stage-smoke: resolving ReconciliationQueue for stage "${stage}"...`);
  const { queueUrl, dlqUrl } = await resolveQueueUrls(sqsClient, stage);

  const dlqBaseline = (await messageCounts(sqsClient, dlqUrl)).visible;
  console.log(`deployed-stage-smoke: DLQ baseline is ${dlqBaseline} message(s).`);

  const message: ReconciliationMessage = {
    version: 1,
    type: 'reconciliation.run',
    occurredAt: new Date().toISOString(),
    payload: {},
  };

  console.log('deployed-stage-smoke: publishing reconciliation.run...');
  await sqsClient.send(
    new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(message) }),
  );

  console.log(`deployed-stage-smoke: waiting for the queue to drain (timeout ${TIMEOUT_MS}ms)...`);
  const deadline = Date.now() + TIMEOUT_MS;
  let consecutiveEmpty = 0;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    const dlqCount = (await messageCounts(sqsClient, dlqUrl)).visible;
    if (dlqCount > dlqBaseline) {
      throw new Error(
        `deployed-stage-smoke: DLQ grew from ${dlqBaseline} to ${dlqCount} — the deployed worker is failing.`,
      );
    }

    const { total } = await messageCounts(sqsClient, queueUrl);
    if (total === 0) {
      consecutiveEmpty += 1;
      if (consecutiveEmpty >= CONSECUTIVE_EMPTY_REQUIRED) {
        console.log(
          'deployed-stage-smoke: queue drained and DLQ unchanged — the deployed worker consumed the message.',
        );
        return;
      }
    } else {
      consecutiveEmpty = 0;
      console.log(`deployed-stage-smoke: ${total} message(s) still in flight...`);
    }
  }

  throw new Error(
    `deployed-stage-smoke: timed out after ${TIMEOUT_MS}ms — the message was not consumed. ` +
      'Check the ReconciliationWorker logs for this stage.',
  );
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error: unknown) => {
    console.error('deployed-stage-smoke: failed.', error);
    process.exitCode = 1;
  });
