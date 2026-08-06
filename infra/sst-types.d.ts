// SST v3 injects the `sst`, `aws`, and `$app` identifiers as ambient globals
// only when its CLI runs `sst.config.ts` — the real declarations live in
// `.sst/platform/config.d.ts`, generated locally by `sst install` (wired up
// as this repo's root `postinstall` script). That generated file re-exports
// SST's own component *source* (not a prebuilt `.d.ts`), so referencing it
// from a package that type-checks under this repo's strict compiler options
// pulls hundreds of vendor files into the program and fails — SST's source
// isn't built against `exactOptionalPropertyTypes` / `noUncheckedIndexedAccess`.
//
// This file declares the narrow subset of that surface `infra/` actually
// calls, matching SST 3's real constructor and prop shapes closely enough to
// type-check this package standalone. The real SST/Pulumi classes are what
// actually run at `sst dev` / `sst deploy` time — these declarations only
// stand in for `pnpm -r typecheck` and `pnpm -r build`.

type Input<T> = T | Output<T>;

interface Output<T> {
  apply<U>(fn: (value: T) => U): Output<U>;
}

declare const $app: {
  readonly name: string;
  readonly stage: string;
};

declare namespace sst {
  class Secret {
    constructor(name: string, placeholder?: string);
    readonly name: string;
    readonly value: Output<string>;
  }

  namespace aws {
    interface QueueArgs {
      visibilityTimeout?: Input<string>;
      delay?: Input<string>;
      dlq?: Input<string | { queue: Input<string>; retry: Input<number> }>;
      transform?: {
        queue?: Partial<{ messageRetentionSeconds: number }>;
      };
    }

    type Linkable = Secret | Queue;

    interface QueueSubscriberArgs {
      handler: string;
      timeout?: Input<string>;
      link?: Input<Linkable[]>;
      environment?: Record<string, Input<string>>;
    }

    interface QueueSubscriptionArgs {
      /** Maps to the event source mapping's `ReportBatchItemFailures` response type. */
      batch?: {
        partialResponses?: boolean;
      };
    }

    class Queue {
      constructor(name: string, args?: QueueArgs);
      readonly name: string;
      readonly arn: Output<string>;
      readonly url: Output<string>;
      // Declared as an arrow-typed property, not a method, so referencing it
      // unbound (e.g. `expect(queue.subscribe).toHaveBeenCalledTimes(...)` in
      // a test against a mock) doesn't trip @typescript-eslint/unbound-method.
      readonly subscribe: (subscriber: string | QueueSubscriberArgs, args?: QueueSubscriptionArgs) => void;
    }

    interface FunctionUrlArgs {
      /** Maps to the Lambda Function URL `AuthType` — `"iam"` is `AWS_IAM`, never `"none"` (`NONE`) for an unverified ingress. */
      authorization?: "iam" | "none";
    }

    interface FunctionArgs {
      handler: string;
      timeout?: Input<string>;
      link?: Input<Linkable[]>;
      environment?: Record<string, Input<string>>;
      url?: Input<boolean | FunctionUrlArgs>;
    }

    class Function {
      constructor(name: string, args: FunctionArgs);
      readonly url: Output<string>;
      readonly arn: Output<string>;
    }

    interface BucketLifecycleRule {
      id: string;
      status: "Enabled" | "Disabled";
      noncurrentVersionTransitions?: Array<{ noncurrentDays: number; storageClass: string }>;
    }

    interface BucketArgs {
      public?: Input<boolean>;
      access?: Input<"public" | "cloudfront">;
      versioning?: Input<boolean>;
      transform?: {
        publicAccessBlock?: Partial<{
          blockPublicAcls: boolean;
          blockPublicPolicy: boolean;
          ignorePublicAcls: boolean;
          restrictPublicBuckets: boolean;
        }>;
        lifecycle?: Partial<{ rules: BucketLifecycleRule[] }>;
      };
    }

    class Bucket {
      constructor(name: string, args?: BucketArgs);
      readonly name: Output<string>;
      readonly arn: Output<string>;
    }

    interface CognitoUserPoolArgs {
      usernames?: Input<Array<"email" | "phone">>;
      transform?: {
        userPool?: (
          args: { passwordPolicy?: Record<string, unknown> },
          opts: unknown,
          name: string,
        ) => undefined;
      };
    }

    interface CognitoUserPoolClientArgs {
      callbackUrls?: Input<string[]>;
    }

    class CognitoUserPoolClient {
      readonly id: Output<string>;
    }

    class CognitoUserPool {
      constructor(name: string, args?: CognitoUserPoolArgs);
      readonly id: Output<string>;
      addClient(name: string, args?: CognitoUserPoolClientArgs): CognitoUserPoolClient;
    }

    interface NextjsArgs {
      path?: string;
      link?: Input<Array<Secret | Queue | Bucket | CognitoUserPool>>;
      environment?: Record<string, Input<string>>;
    }

    class Nextjs {
      constructor(name: string, args?: NextjsArgs);
      readonly url: Output<string>;
    }
  }
}

declare namespace aws {
  namespace cognito {
    class UserPoolDomain {
      constructor(name: string, args: { domain: Input<string>; userPoolId: Input<string> });
    }
  }

  namespace iam {
    class Role {
      constructor(name: string, args: { assumeRolePolicy: Input<string> });
      readonly id: Output<string>;
      readonly arn: Output<string>;
    }

    class RolePolicy {
      constructor(name: string, args: { role: Input<string>; policy: Input<string> });
    }
  }

  namespace cloudwatch {
    class MetricAlarm {
      constructor(
        name: string,
        args: {
          namespace: string;
          metricName: string;
          dimensions: Record<string, Input<string>>;
          statistic: string;
          period: number;
          evaluationPeriods: number;
          threshold: number;
          comparisonOperator: string;
          treatMissingData: string;
          alarmActions: Input<string>[];
        },
      );
    }
  }

  namespace sns {
    class Topic {
      constructor(name: string, args?: Record<string, never>);
      readonly arn: Output<string>;
    }
  }
}
