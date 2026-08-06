// WS-10 owns the queues, DLQs, alarms, and secrets. WS-11 (below
// `attachWorkers`) owns everything that attaches a handler to them: the
// `square-webhook` package's Function URL and each queue's Lambda consumer.
import type { SecretName, Secrets } from "./secrets";

export interface QueueDefinition {
  readonly name: string;
  readonly dlqName: string;
  /** The timeout of the function that will eventually consume this queue (WS-11). */
  readonly consumerTimeoutSeconds: number;
  readonly visibilityTimeoutSeconds: number;
  readonly maxReceiveCount: number;
  readonly dlqRetentionSeconds: number;
  /** Alarm threshold for a stalled consumer that isn't yet dead-lettering. */
  readonly oldestMessageAgeAlarmThresholdSeconds: number;
}

const FOURTEEN_DAYS_SECONDS = 14 * 24 * 60 * 60;
const VISIBILITY_TIMEOUT_MULTIPLE = 6;

function defineQueue(
  name: string,
  consumerTimeoutSeconds: number,
  oldestMessageAgeAlarmThresholdSeconds: number,
): QueueDefinition {
  return {
    name,
    dlqName: `${name}DLQ`,
    consumerTimeoutSeconds,
    visibilityTimeoutSeconds: consumerTimeoutSeconds * VISIBILITY_TIMEOUT_MULTIPLE,
    maxReceiveCount: 5,
    dlqRetentionSeconds: FOURTEEN_DAYS_SECONDS,
    oldestMessageAgeAlarmThresholdSeconds,
  };
}

export const QUEUE_DEFINITIONS: readonly QueueDefinition[] = [
  defineQueue("SquareWebhookQueue", 30, 15 * 60),
  defineQueue("NotificationQueue", 30, 15 * 60),
  defineQueue("ReconciliationQueue", 60, 30 * 60),
  defineQueue("ScheduledTaskQueue", 60, 30 * 60),
];

export interface QueueResources {
  readonly queues: Record<string, sst.aws.Queue>;
  readonly dlqs: Record<string, sst.aws.Queue>;
}

export function createQueues(): QueueResources {
  const queues: Record<string, sst.aws.Queue> = {};
  const dlqs: Record<string, sst.aws.Queue> = {};

  for (const definition of QUEUE_DEFINITIONS) {
    const dlq = new sst.aws.Queue(definition.dlqName, {
      transform: {
        queue: { messageRetentionSeconds: definition.dlqRetentionSeconds },
      },
    });
    dlqs[definition.name] = dlq;

    queues[definition.name] = new sst.aws.Queue(definition.name, {
      visibilityTimeout: `${definition.visibilityTimeoutSeconds} seconds`,
      dlq: { queue: dlq.arn, retry: definition.maxReceiveCount },
    });
  }

  return { queues, dlqs };
}

// ---------------------------------------------------------------------------
// WS-11: worker wiring. Pure data below (`QUEUE_SUBSCRIBER_DEFINITIONS`,
// `SQUARE_WEBHOOK_HTTP_DEFINITION`) is exercised directly by
// queues.test.ts; `attachWorkers` uses it to construct the real SST
// resources, which only runs under `sst dev` / `sst deploy`.
// ---------------------------------------------------------------------------

function consumerTimeoutSecondsFor(queueName: string): number {
  const definition = QUEUE_DEFINITIONS.find((candidate) => candidate.name === queueName);
  if (definition === undefined) {
    throw new Error(`No queue named "${queueName}".`);
  }
  return definition.consumerTimeoutSeconds;
}

export interface QueueSubscriberDefinition {
  readonly queueName: string;
  readonly functionName: string;
  readonly handler: string;
  /** Must equal the matching QueueDefinition.consumerTimeoutSeconds (WS-10 sizes the visibility timeout off this). */
  readonly timeoutSeconds: number;
  /** Every SQS handler enables this, and pairs with the handler returning `batchItemFailures`. */
  readonly reportBatchItemFailures: true;
  readonly extraSecretNames: readonly SecretName[];
  readonly extraEnvVarNames: readonly string[];
}

// Every worker gets DATABASE_URL_POOLED and DATABASE_URL_DIRECT (below, in
// `attachWorkers`) — this table only lists the mapping *beyond* that, per
// AGENTS.md "no resource created by hand" and WS-11 step 9's linkage table.
// SquareWebhookSignatureKey is mapped onto square-webhook only.
export const QUEUE_SUBSCRIBER_DEFINITIONS: readonly QueueSubscriberDefinition[] = [
  {
    queueName: "SquareWebhookQueue",
    functionName: "SquareWebhookConsumer",
    handler: "functions/square-webhook/src/consumer.queueHandler",
    timeoutSeconds: consumerTimeoutSecondsFor("SquareWebhookQueue"),
    reportBatchItemFailures: true,
    extraSecretNames: ["SquareWebhookSignatureKey"],
    extraEnvVarNames: [],
  },
  {
    queueName: "NotificationQueue",
    functionName: "NotificationWorker",
    handler: "functions/notification-worker/src/handler.handler",
    timeoutSeconds: consumerTimeoutSecondsFor("NotificationQueue"),
    reportBatchItemFailures: true,
    extraSecretNames: [],
    // Non-production stages only — see attachWorkers.
    extraEnvVarNames: ["KEKI_ALLOW_NOOP_PROVIDERS"],
  },
  {
    queueName: "ReconciliationQueue",
    functionName: "ReconciliationWorker",
    handler: "functions/reconciliation-worker/src/handler.handler",
    timeoutSeconds: consumerTimeoutSecondsFor("ReconciliationQueue"),
    reportBatchItemFailures: true,
    extraSecretNames: [],
    extraEnvVarNames: [],
  },
  {
    queueName: "ScheduledTaskQueue",
    functionName: "ScheduledTaskWorker",
    handler: "functions/scheduled-task-worker/src/handler.handler",
    timeoutSeconds: consumerTimeoutSecondsFor("ScheduledTaskQueue"),
    reportBatchItemFailures: true,
    extraSecretNames: [],
    // Lets the worker enqueue a notification.drain message for the one
    // known task key; not a secret, just a resource URL.
    extraEnvVarNames: ["NOTIFICATION_QUEUE_URL"],
  },
];

export interface HttpFunctionDefinition {
  readonly functionName: string;
  readonly handler: string;
  readonly timeoutSeconds: number;
  /** Lambda Function URL AuthType — never NONE while verification isn't Square-compatible (see verify-signature.ts). */
  readonly authType: "AWS_IAM";
  readonly extraSecretNames: readonly SecretName[];
  readonly extraEnvVarNames: readonly string[];
}

export const SQUARE_WEBHOOK_HTTP_DEFINITION: HttpFunctionDefinition = {
  functionName: "SquareWebhookHttp",
  handler: "functions/square-webhook/src/http.httpHandler",
  timeoutSeconds: 10,
  authType: "AWS_IAM",
  extraSecretNames: ["SquareWebhookSignatureKey"],
  extraEnvVarNames: ["SQUARE_WEBHOOK_QUEUE_URL"],
};

export interface WorkerResources {
  readonly squareWebhookHttp: sst.aws.Function;
}

// The one deliberate SC-11 exception (see functions/square-webhook/src/verify-signature.ts):
// Phase 1's signature verification is not Square-compatible, so the Function
// URL created here must never accept unauthenticated requests.
export function attachWorkers(resources: QueueResources, secrets: Secrets): WorkerResources {
  for (const definition of QUEUE_SUBSCRIBER_DEFINITIONS) {
    const queue = resources.queues[definition.queueName];
    if (queue === undefined) {
      throw new Error(
        `attachWorkers: no queue named "${definition.queueName}" for subscriber "${definition.functionName}".`,
      );
    }

    const link: sst.aws.Linkable[] = [secrets.NeonPooledUrl, secrets.NeonDirectUrl];
    const environment: Record<string, Input<string>> = {
      DATABASE_URL_POOLED: secrets.NeonPooledUrl.value,
      DATABASE_URL_DIRECT: secrets.NeonDirectUrl.value,
    };

    if (definition.extraSecretNames.includes("SquareWebhookSignatureKey")) {
      link.push(secrets.SquareWebhookSignatureKey);
      environment["SQUARE_WEBHOOK_SIGNATURE_KEY"] = secrets.SquareWebhookSignatureKey.value;
    }

    if (definition.extraEnvVarNames.includes("KEKI_ALLOW_NOOP_PROVIDERS") && $app.stage !== "production") {
      environment["KEKI_ALLOW_NOOP_PROVIDERS"] = "true";
    }

    if (definition.extraEnvVarNames.includes("NOTIFICATION_QUEUE_URL")) {
      const notificationQueue = resources.queues["NotificationQueue"];
      if (notificationQueue === undefined) {
        throw new Error('attachWorkers: "NotificationQueue" is required to link ScheduledTaskWorker.');
      }
      link.push(notificationQueue);
      environment["NOTIFICATION_QUEUE_URL"] = notificationQueue.url;
    }

    queue.subscribe(
      {
        handler: definition.handler,
        timeout: `${definition.timeoutSeconds} seconds`,
        link,
        environment,
      },
      { batch: { partialResponses: definition.reportBatchItemFailures } },
    );
  }

  const squareWebhookQueue = resources.queues["SquareWebhookQueue"];
  if (squareWebhookQueue === undefined) {
    throw new Error('attachWorkers: "SquareWebhookQueue" is required for the square-webhook HTTP ingress.');
  }

  const squareWebhookHttp = new sst.aws.Function(SQUARE_WEBHOOK_HTTP_DEFINITION.functionName, {
    handler: SQUARE_WEBHOOK_HTTP_DEFINITION.handler,
    timeout: `${SQUARE_WEBHOOK_HTTP_DEFINITION.timeoutSeconds} seconds`,
    link: [secrets.NeonPooledUrl, secrets.NeonDirectUrl, secrets.SquareWebhookSignatureKey, squareWebhookQueue],
    environment: {
      DATABASE_URL_POOLED: secrets.NeonPooledUrl.value,
      DATABASE_URL_DIRECT: secrets.NeonDirectUrl.value,
      SQUARE_WEBHOOK_SIGNATURE_KEY: secrets.SquareWebhookSignatureKey.value,
      SQUARE_WEBHOOK_QUEUE_URL: squareWebhookQueue.url,
    },
    url: { authorization: "iam" },
  });

  return { squareWebhookHttp };
}
