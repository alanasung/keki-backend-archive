import { createAlarms } from "./alarms";
import { createAuth } from "./auth";
import { attachWorkers, createQueues } from "./queues";
import { createSchedulerRole } from "./scheduler";
import { createSecrets } from "./secrets";
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

  createAlarms(queueResources);
  createSchedulerRole(queueResources);
  const workers = attachWorkers(queueResources, secrets);

  // Derived from the provider, whose region sst.config.ts's app() block
  // sets — the single place the region is configured.
  const web = createWeb({ secrets, auth, region: aws.getRegionOutput().apply((r) => r.name) });

  return {
    webUrl: web.url,
    bucketArn: bucket.arn,
    userPoolId: auth.userPool.id,
    squareWebhookUrl: workers.squareWebhookHttp.url,
  };
}
