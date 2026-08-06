import { createAlarms } from "./alarms";
import { createAuth } from "./auth";
import { attachWorkers, createQueues } from "./queues";
import { createSchedulerRole } from "./scheduler";
import { createSecrets } from "./secrets";
import { createDocumentsBucket } from "./storage";
import { createWeb } from "./web";

export const AWS_REGION = "us-east-1";

export function createInfra(): {
  webUrl: Output<string>;
  bucketArn: Output<string>;
  userPoolId: Output<string>;
  squareWebhookUrl: Output<string>;
} {
  const secrets = createSecrets();
  const bucket = createDocumentsBucket();
  const auth = createAuth(`keki-${$app.stage}`);
  const queueResources = createQueues();

  createAlarms(queueResources);
  createSchedulerRole(queueResources);
  const workers = attachWorkers(queueResources, secrets);

  const web = createWeb({ secrets, auth, region: AWS_REGION });

  return {
    webUrl: web.url,
    bucketArn: bucket.arn,
    userPoolId: auth.userPool.id,
    squareWebhookUrl: workers.squareWebhookHttp.url,
  };
}
