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
    // Key by the DLQ's own name, not the parent queue's. `createAlarms` merges
    // these two maps (`{ ...queues, ...dlqs }`) and looks alarms up by
    // `dlqName`; keying by `definition.name` both loses the DLQ entry and lets
    // each DLQ overwrite its parent queue, so the main-queue alarms would
    // silently watch the DLQ instead.
    dlqs[definition.dlqName] = dlq;

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
  /**
   * Lambda Function URL AuthType. Public (`"none"`) since WS-11 (SC-11) —
   * the endpoint's only protection is Square's signature verification in
   * `@keki/square-client`, exercised by WS-03 tests 1–8 and WS-10 tests
   * 1–4. Phase 1's verifier here was not Square-compatible, which is why
   * the URL stayed `"iam"`-authed until that verifier replaced it.
   */
  readonly authType: "none";
  readonly extraSecretNames: readonly SecretName[];
  readonly extraEnvVarNames: readonly string[];
}

export const SQUARE_WEBHOOK_HTTP_DEFINITION: HttpFunctionDefinition = {
  functionName: "SquareWebhookHttp",
  handler: "functions/square-webhook/src/http.httpHandler",
  timeoutSeconds: 10,
  authType: "none",
  extraSecretNames: ["SquareWebhookSignatureKey", "SquareAccessToken", "SquareEnvironment", "SquareNotificationUrl"],
  extraEnvVarNames: ["SQUARE_WEBHOOK_QUEUE_URL"],
};

export interface WorkerResources {
  readonly squareWebhookHttp: sst.aws.Function;
}

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

  // WS-11 (SC-11): this Function URL is public. Its sole protection is
  // Square's real signature verification in `@keki/square-client`
  // (`verifySquareSignature`), exercised by WS-03 tests 1–8 and wired into
  // `httpHandler` by WS-10 (tests 1–4). Phase 1's generic HMAC verifier was
  // not Square-compatible, which is why this URL stayed `"iam"`-authed
  // (unreachable from the public internet) until that verifier replaced it —
  // do not widen this again without an equally-real verifier in front of it.
  const squareWebhookHttp = new sst.aws.Function(SQUARE_WEBHOOK_HTTP_DEFINITION.functionName, {
    handler: SQUARE_WEBHOOK_HTTP_DEFINITION.handler,
    timeout: `${SQUARE_WEBHOOK_HTTP_DEFINITION.timeoutSeconds} seconds`,
    link: [
      secrets.NeonPooledUrl,
      secrets.NeonDirectUrl,
      secrets.SquareWebhookSignatureKey,
      secrets.SquareAccessToken,
      secrets.SquareEnvironment,
      secrets.SquareNotificationUrl,
      squareWebhookQueue,
    ],
    environment: {
      DATABASE_URL_POOLED: secrets.NeonPooledUrl.value,
      DATABASE_URL_DIRECT: secrets.NeonDirectUrl.value,
      SQUARE_WEBHOOK_SIGNATURE_KEY: secrets.SquareWebhookSignatureKey.value,
      SQUARE_WEBHOOK_QUEUE_URL: squareWebhookQueue.url,
      SQUARE_ACCESS_TOKEN: secrets.SquareAccessToken.value,
      SQUARE_ENVIRONMENT: secrets.SquareEnvironment.value,
      // Sourced from the configured secret, never from `squareWebhookHttp.url`
      // itself — the Function URL is an output *of* this function, so its own
      // environment cannot depend on it without a cycle. See
      // `assertSquareNotificationUrlMatches` below for what keeps this
      // correct across redeploys.
      SQUARE_NOTIFICATION_URL: secrets.SquareNotificationUrl.value,
    },
    url: { authorization: SQUARE_WEBHOOK_HTTP_DEFINITION.authType },
  });

  return { squareWebhookHttp };
}

// WS-11 step 3: the configured `SquareNotificationUrl` secret and the real,
// deployed Function URL must agree character for character — a trailing-
// slash difference produces a verifier that rejects every genuine delivery,
// indistinguishable from an attack. A redeployed stage that mints a new
// Function URL would otherwise silently break every webhook, with the only
// symptom being the signature-failure alarm (`alarms.ts`) looking like an
// attack. Kept as a plain function (rather than inline in the `.apply()` in
// `infra/index.ts`) so it can be asserted on directly, without a live Pulumi
// Output.
export function assertSquareNotificationUrlMatches(configuredNotificationUrl: string, actualFunctionUrl: string): void {
  if (configuredNotificationUrl !== actualFunctionUrl) {
    throw new Error(
      `Refusing to deploy: the SquareNotificationUrl secret ("${configuredNotificationUrl}") does not match ` +
        `the deployed square-webhook Function URL ("${actualFunctionUrl}"). Set the secret to the Function URL, ` +
        "character for character (a trailing slash counts), and redeploy: " +
        "`pnpm sst secret set SquareNotificationUrl <url> --stage <stage>`.",
    );
  }
}
