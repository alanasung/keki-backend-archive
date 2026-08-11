import { createAlarms, createSignatureFailureAlarm } from "./alarms";
import { createAuth } from "./auth";
import { assertSquareNotificationUrlMatches, attachWorkers, createQueues } from "./queues";
import { createSchedulerRole, createSchedules } from "./scheduler";
import { createSecrets, type Secrets } from "./secrets";
import { createDocumentsBucket } from "./storage";
import { createWeb } from "./web";

// The only account this stack may deploy to (docs/aws-iam-request.md). SST
// deploys to whatever account the ambient credentials resolve to, so a
// developer with the wrong SSO profile active would otherwise silently
// provision the whole stack elsewhere.
export const EXPECTED_ACCOUNT_ID = "495504746201";

function assertExpectedAccount(): void {
  aws.getCallerIdentityOutput({}).apply(({ accountId }) => {
    if (accountId !== EXPECTED_ACCOUNT_ID) {
      throw new Error(
        `Refusing to deploy: credentials resolve to AWS account ${accountId}, ` +
          `expected ${EXPECTED_ACCOUNT_ID}. Check your AWS profile / SSO session.`,
      );
    }
    return accountId;
  });
}

// WS-11 step 3: the deploy-time counterpart to `assertSquareNotificationUrlMatches`
// (queues.ts) — resolves the configured secret and the real Function URL,
// then fails the deploy on any disagreement, including a trailing slash.
function assertNotificationUrlConfigured(secrets: Secrets, squareWebhookUrl: Output<string>): void {
  $resolve([secrets.SquareNotificationUrl.value, squareWebhookUrl]).apply(([configured, actual]) => {
    assertSquareNotificationUrlMatches(configured, actual);
    return actual;
  });
}

export function createInfra(): {
  webUrl: Output<string>;
  bucketArn: Output<string>;
  userPoolId: Output<string>;
  squareWebhookUrl: Output<string>;
} {
  assertExpectedAccount();
  const secrets = createSecrets();
  const bucket = createDocumentsBucket();
  const auth = createAuth(`keki-${$app.stage}`);
  const queueResources = createQueues();

  const { topic } = createAlarms(queueResources);
  const schedulerRole = createSchedulerRole(queueResources);
  createSchedules(queueResources, schedulerRole);
  const workers = attachWorkers(queueResources, secrets);
  createSignatureFailureAlarm(workers.squareWebhookHttp, topic);
  assertNotificationUrlConfigured(secrets, workers.squareWebhookHttp.url);

  const web = createWeb({ secrets, auth });

  return {
    webUrl: web.url,
    bucketArn: bucket.arn,
    userPoolId: auth.userPool.id,
    squareWebhookUrl: workers.squareWebhookHttp.url,
  };
}
