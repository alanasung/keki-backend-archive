import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ALARM_DEFINITIONS } from "./alarms";
import {
  attachWorkers,
  QUEUE_DEFINITIONS,
  QUEUE_SUBSCRIBER_DEFINITIONS,
  SQUARE_WEBHOOK_HTTP_DEFINITION,
  type QueueResources,
} from "./queues";
import type { Secrets } from "./secrets";

const EXPECTED_QUEUE_NAMES = [
  "SquareWebhookQueue",
  "NotificationQueue",
  "ReconciliationQueue",
  "ScheduledTaskQueue",
];

describe("QUEUE_DEFINITIONS", () => {
  it("declares exactly the four required queues", () => {
    expect(QUEUE_DEFINITIONS.map((q) => q.name).sort()).toEqual([...EXPECTED_QUEUE_NAMES].sort());
  });

  it("gives every queue its own, distinct DLQ", () => {
    const dlqNames = QUEUE_DEFINITIONS.map((q) => q.dlqName);
    expect(new Set(dlqNames).size).toBe(dlqNames.length);
    for (const definition of QUEUE_DEFINITIONS) {
      expect(definition.dlqName).toBeTruthy();
      expect(definition.dlqName).not.toBe(definition.name);
    }
  });

  it("bounds every maxReceiveCount between 1 and 10", () => {
    for (const definition of QUEUE_DEFINITIONS) {
      expect(definition.maxReceiveCount).toBeGreaterThanOrEqual(1);
      expect(definition.maxReceiveCount).toBeLessThanOrEqual(10);
    }
  });

  it("sets visibility timeout to at least six times the consumer timeout", () => {
    for (const definition of QUEUE_DEFINITIONS) {
      expect(definition.visibilityTimeoutSeconds).toBeGreaterThanOrEqual(definition.consumerTimeoutSeconds * 6);
    }
  });

  it("retains DLQ messages for 14 days", () => {
    for (const definition of QUEUE_DEFINITIONS) {
      expect(definition.dlqRetentionSeconds).toBe(14 * 24 * 60 * 60);
    }
  });
});

describe("QUEUE_SUBSCRIBER_DEFINITIONS (WS-11 deliverable)", () => {
  it("subscribes exactly the four queues, one subscriber each", () => {
    expect(QUEUE_SUBSCRIBER_DEFINITIONS.map((d) => d.queueName).sort()).toEqual(
      [...EXPECTED_QUEUE_NAMES].sort(),
    );
  });

  it("enables reportBatchItemFailures on every subscriber", () => {
    for (const definition of QUEUE_SUBSCRIBER_DEFINITIONS) {
      expect(definition.reportBatchItemFailures).toBe(true);
    }
  });

  it("maps SquareWebhookSignatureKey onto square-webhook only", () => {
    for (const definition of QUEUE_SUBSCRIBER_DEFINITIONS) {
      const expectsSquareSecret = definition.queueName === "SquareWebhookQueue";
      expect(definition.extraSecretNames.includes("SquareWebhookSignatureKey")).toBe(expectsSquareSecret);
    }
    expect(SQUARE_WEBHOOK_HTTP_DEFINITION.extraSecretNames).toContain("SquareWebhookSignatureKey");
    expect(SQUARE_WEBHOOK_HTTP_DEFINITION.authType).toBe("AWS_IAM");
  });

  it("sets KEKI_ALLOW_NOOP_PROVIDERS only on the notification worker", () => {
    for (const definition of QUEUE_SUBSCRIBER_DEFINITIONS) {
      const expectsOverrideVar = definition.queueName === "NotificationQueue";
      expect(definition.extraEnvVarNames.includes("KEKI_ALLOW_NOOP_PROVIDERS")).toBe(expectsOverrideVar);
    }
  });

  it("gives every subscriber the same timeout as the queue's consumerTimeoutSeconds", () => {
    for (const definition of QUEUE_SUBSCRIBER_DEFINITIONS) {
      const queueDefinition = QUEUE_DEFINITIONS.find((q) => q.name === definition.queueName);
      expect(queueDefinition).toBeDefined();
      expect(definition.timeoutSeconds).toBe(queueDefinition?.consumerTimeoutSeconds);
    }
  });
});

// Exercises the real `attachWorkers` wiring logic against hand-built fakes
// for the `sst`/`$app` globals SST's CLI would otherwise inject — this repo
// has no runtime `sst` object outside `sst dev`/`sst deploy` (see
// sst-types.d.ts), so a plain Vitest run needs its own stand-in to call this
// function at all.
describe("attachWorkers (WS-11 deliverable)", () => {
  class FakeSstFunction {
    readonly url = "https://fake-function-url.example.com/";
    readonly arn = "arn:aws:lambda:us-east-1:000000000000:function:fake";
    readonly name: string;
    readonly args: unknown;
    constructor(name: string, args: unknown) {
      this.name = name;
      this.args = args;
    }
  }

  beforeAll(() => {
    (globalThis as Record<string, unknown>)["sst"] = { aws: { Function: FakeSstFunction } };
    (globalThis as Record<string, unknown>)["$app"] = { stage: "dev", name: "keki" };
  });

  function fakeSecret(name: string): { name: string; value: string } {
    return { name, value: `\${secret:${name}}` };
  }

  function fakeQueue(name: string): sst.aws.Queue & { subscribe: ReturnType<typeof vi.fn> } {
    return {
      name,
      arn: `arn:aws:sqs:us-east-1:000000000000:${name}`,
      url: `https://sqs.us-east-1.amazonaws.com/000000000000/${name}`,
      subscribe: vi.fn(),
    } as unknown as sst.aws.Queue & { subscribe: ReturnType<typeof vi.fn> };
  }

  function buildResources(): {
    resources: QueueResources;
    queues: Record<string, sst.aws.Queue & { subscribe: ReturnType<typeof vi.fn> }>;
  } {
    const queues = {
      SquareWebhookQueue: fakeQueue("SquareWebhookQueue"),
      NotificationQueue: fakeQueue("NotificationQueue"),
      ReconciliationQueue: fakeQueue("ReconciliationQueue"),
      ScheduledTaskQueue: fakeQueue("ScheduledTaskQueue"),
    };
    return { resources: { queues, dlqs: {} }, queues };
  }

  const fakeSecrets = {
    NeonPooledUrl: fakeSecret("NeonPooledUrl"),
    NeonDirectUrl: fakeSecret("NeonDirectUrl"),
    SquareAccessToken: fakeSecret("SquareAccessToken"),
    SquareWebhookSignatureKey: fakeSecret("SquareWebhookSignatureKey"),
    KlaviyoApiKey: fakeSecret("KlaviyoApiKey"),
    WaiverProviderApiKey: fakeSecret("WaiverProviderApiKey"),
    KioskDeviceToken: fakeSecret("KioskDeviceToken"),
  } as unknown as Secrets;

  it("links every queue subscriber to both database URLs (test 14a)", () => {
    const { resources, queues } = buildResources();
    attachWorkers(resources, fakeSecrets);

    for (const [queueName, queue] of Object.entries(queues)) {
      expect(queue.subscribe).toHaveBeenCalledTimes(1);
      const [subscriber] = queue.subscribe.mock.calls[0] as [{ environment: Record<string, unknown> }];
      expect(subscriber.environment["DATABASE_URL_POOLED"]).toBe(fakeSecrets.NeonPooledUrl.value);
      expect(subscriber.environment["DATABASE_URL_DIRECT"]).toBe(fakeSecrets.NeonDirectUrl.value);
      void queueName;
    }
  });

  it("links the square-webhook HTTP ingress to both database URLs and its signature key", () => {
    const { resources } = buildResources();
    const workers = attachWorkers(resources, fakeSecrets);
    const fn = workers.squareWebhookHttp as unknown as FakeSstFunction;
    const args = fn.args as { environment: Record<string, unknown>; url: { authorization: string } };

    expect(args.environment["DATABASE_URL_POOLED"]).toBe(fakeSecrets.NeonPooledUrl.value);
    expect(args.environment["DATABASE_URL_DIRECT"]).toBe(fakeSecrets.NeonDirectUrl.value);
    expect(args.environment["SQUARE_WEBHOOK_SIGNATURE_KEY"]).toBe(fakeSecrets.SquareWebhookSignatureKey.value);
    expect(args.url.authorization).toBe("iam");
  });

  it("maps the signature key onto the SquareWebhookQueue subscriber only", () => {
    const { resources, queues } = buildResources();
    attachWorkers(resources, fakeSecrets);

    for (const [queueName, queue] of Object.entries(queues)) {
      const [subscriber] = queue.subscribe.mock.calls[0] as [{ environment: Record<string, unknown> }];
      const hasSignatureKey = "SQUARE_WEBHOOK_SIGNATURE_KEY" in subscriber.environment;
      expect(hasSignatureKey).toBe(queueName === "SquareWebhookQueue");
    }
  });

  it("enables partial batch responses on every subscription", () => {
    const { resources, queues } = buildResources();
    attachWorkers(resources, fakeSecrets);

    for (const queue of Object.values(queues)) {
      const [, subscriptionArgs] = queue.subscribe.mock.calls[0] as [unknown, { batch?: { partialResponses?: boolean } }];
      expect(subscriptionArgs.batch?.partialResponses).toBe(true);
    }
  });

  it("sets KEKI_ALLOW_NOOP_PROVIDERS on the notification worker outside production", () => {
    const { resources, queues } = buildResources();
    attachWorkers(resources, fakeSecrets);

    const [subscriber] = queues["NotificationQueue"]!.subscribe.mock.calls[0] as [
      { environment: Record<string, unknown> },
    ];
    expect(subscriber.environment["KEKI_ALLOW_NOOP_PROVIDERS"]).toBe("true");
  });

  it("does not set KEKI_ALLOW_NOOP_PROVIDERS in the production stage", () => {
    (globalThis as Record<string, unknown>)["$app"] = { stage: "production", name: "keki" };
    const { resources, queues } = buildResources();
    attachWorkers(resources, fakeSecrets);

    const [subscriber] = queues["NotificationQueue"]!.subscribe.mock.calls[0] as [
      { environment: Record<string, unknown> },
    ];
    expect(subscriber.environment["KEKI_ALLOW_NOOP_PROVIDERS"]).toBeUndefined();

    (globalThis as Record<string, unknown>)["$app"] = { stage: "dev", name: "keki" };
  });

  it("links the scheduled-task worker to the notification queue's URL", () => {
    const { resources, queues } = buildResources();
    attachWorkers(resources, fakeSecrets);

    const [subscriber] = queues["ScheduledTaskQueue"]!.subscribe.mock.calls[0] as [
      { environment: Record<string, unknown> },
    ];
    expect(subscriber.environment["NOTIFICATION_QUEUE_URL"]).toBe(queues["NotificationQueue"]!.url);
  });
});

describe("functions/ (WS-11 deliverable)", () => {
  const functionsDir = fileURLToPath(new URL("../functions", import.meta.url));
  const entries = readdirSync(functionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  it("contains exactly four packages, matching the four workers (test 15)", () => {
    expect(entries).toEqual(
      ["notification-worker", "reconciliation-worker", "scheduled-task-worker", "square-webhook"].sort(),
    );
  });

  it("no function package depends on another function package (test 14)", () => {
    const functionPackageNames = new Set(
      entries.map((dir) => {
        const packageJson = JSON.parse(readFileSync(`${functionsDir}/${dir}/package.json`, "utf8")) as {
          name: string;
        };
        return packageJson.name;
      }),
    );

    for (const dir of entries) {
      const packageJson = JSON.parse(readFileSync(`${functionsDir}/${dir}/package.json`, "utf8")) as {
        dependencies?: Record<string, string>;
      };
      const dependencyNames = Object.keys(packageJson.dependencies ?? {});
      const crossFunctionDependencies = dependencyNames.filter((name) => functionPackageNames.has(name));
      expect(crossFunctionDependencies).toEqual([]);
    }
  });
});

describe("ALARM_DEFINITIONS", () => {
  it("declares exactly one alarm per DLQ on message count, and one per main queue on message age", () => {
    expect(ALARM_DEFINITIONS.length).toBe(8);

    const dlqAlarms = ALARM_DEFINITIONS.filter((a) => a.metricName === "ApproximateNumberOfMessagesVisible");
    expect(dlqAlarms.length).toBe(4);
    for (const alarm of dlqAlarms) {
      expect(alarm.threshold).toBeGreaterThanOrEqual(1);
      expect(QUEUE_DEFINITIONS.some((q) => q.dlqName === alarm.queueRefName)).toBe(true);
    }

    const ageAlarms = ALARM_DEFINITIONS.filter((a) => a.metricName === "ApproximateAgeOfOldestMessage");
    expect(ageAlarms.length).toBe(4);
    for (const alarm of ageAlarms) {
      expect(QUEUE_DEFINITIONS.some((q) => q.name === alarm.queueRefName)).toBe(true);
    }
  });

  // Regression: `createQueues` keyed its `dlqs` map by `definition.name`
  // instead of `definition.dlqName`. Because `createAlarms` resolves alarms
  // against `{ ...queues, ...dlqs }`, that both dropped every DLQ entry (the
  // deploy died on "No queue named SquareWebhookQueueDLQ") and let each DLQ
  // overwrite its parent queue, so the four age alarms would silently have
  // watched the DLQs instead.
  //
  // This has to call `createQueues` rather than compare QUEUE_DEFINITIONS
  // against ALARM_DEFINITIONS: those two were always consistent with each
  // other, and the fault lay entirely in how the returned map was keyed. The
  // `attachWorkers` tests above pass `dlqs: {}`, so nothing else builds the
  // real key set.
  it("keys createQueues' dlqs map so createAlarms can resolve every alarm", async () => {
    const previousSst = (globalThis as Record<string, unknown>)["sst"];

    class FakeQueue {
      readonly arn: string;
      constructor(readonly resourceName: string) {
        this.arn = `arn:aws:sqs:us-east-1:000000000000:${resourceName}`;
      }
    }
    (globalThis as Record<string, unknown>)["sst"] = { aws: { Queue: FakeQueue } };

    try {
      const { createQueues } = await import("./queues");
      const { queues, dlqs } = createQueues();

      expect(Object.keys(dlqs).sort()).toEqual(QUEUE_DEFINITIONS.map((d) => d.dlqName).sort());

      // The exact merge createAlarms performs: no DLQ may shadow its parent.
      const resolved = { ...queues, ...dlqs };
      expect(Object.keys(resolved).length).toBe(QUEUE_DEFINITIONS.length * 2);

      for (const alarm of ALARM_DEFINITIONS) {
        expect(resolved[alarm.queueRefName]).toBeDefined();
      }
    } finally {
      (globalThis as Record<string, unknown>)["sst"] = previousSst;
    }
  });

  it("treats missing data as not breaching on every alarm", () => {
    for (const alarm of ALARM_DEFINITIONS) {
      expect(alarm.treatMissingData).toBe("notBreaching");
    }
  });
});
