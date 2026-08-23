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
      /**
       * Maps to the Lambda Function URL `AuthType` — `"iam"` is `AWS_IAM`,
       * `"none"` is `NONE`. WS-11 (SC-11) opens `square-webhook`'s URL with
       * `"none"` now that `@keki/square-client`'s real Square-compatible
       * verifier (WS-03) is wired into the HTTP entry point (WS-10) — see
       * the invariant comment on `SQUARE_WEBHOOK_HTTP_DEFINITION` in
       * `queues.ts`. Do not default a new public Function URL to `"none"`
       * without an equivalent verifier in front of it.
       */
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
      /** The physical Lambda function name. */
      readonly name: Output<string>;
      /**
       * SST's own child resources. `logGroup` is the function's CloudWatch
       * Log Group: SST creates it (retention defaults to one month) rather
       * than leaving Lambda to make it lazily on first invocation. Anything
       * that needs the log group must take its name from here — a name
       * derived as `/aws/lambda/<name>` carries no dependency on the group,
       * so Pulumi is free to run the dependent resource first and fail on a
       * group that does not exist yet.
       *
       * `name` is modelled as a plain `string` because Pulumi flattens the
       * nested `Output` that the real type returns; this stand-in describes
       * the observable result of `.apply`, not the intermediate shape.
       */
      readonly nodes: {
        readonly logGroup: Output<{ readonly name: string }>;
      };
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

    // The underlying `aws.cognito.UserPoolClient` args reachable through
    // `CognitoUserPoolClientArgs.transform.client` — the escape hatch WS-02
    // uses for OAuth fields `addClient`'s first-class options don't cover.
    interface CognitoUserPoolClientTransformArgs {
      allowedOauthFlows?: Input<string[]>;
      allowedOauthFlowsUserPoolClient?: Input<boolean>;
      allowedOauthScopes?: Input<string[]>;
      callbackUrls?: Input<string[]>;
      logoutUrls?: Input<string[]>;
      supportedIdentityProviders?: Input<string[]>;
      generateSecret?: Input<boolean>;
    }

    interface CognitoUserPoolClientArgs {
      callbackUrls?: Input<string[]>;
      transform?: {
        client?: (args: CognitoUserPoolClientTransformArgs) => undefined;
      };
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

// The narrow subset of SST's global `$` helpers (`.sst/platform/src/global.d.ts`)
// this package actually calls — see the file-level comment above.
declare function $resolve<T1, T2>(values: [Input<T1>, Input<T2>]): Output<[T1, T2]>;

// Real Pulumi Outputs of object types lift property access (`Output<T>` is
// `OutputInstance<T> & Lifted<T>`), so `aws.getRegionOutput().name` is
// itself a valid `Output<string>` without an intermediate `.apply()`. This
// stand-in models that directly rather than reproducing Pulumi's generic
// `Lifted<T>` proxy type.
declare function $interpolate(strings: TemplateStringsArray, ...values: Input<unknown>[]): Output<string>;

declare namespace aws {
  function getCallerIdentityOutput(args?: Record<string, never>): Output<{ accountId: string }>;
  function getRegionOutput(args?: Record<string, never>): { readonly name: Output<string> };

  namespace scheduler {
    interface ScheduleFlexibleTimeWindow {
      mode: "OFF";
    }

    interface ScheduleTarget {
      arn: Input<string>;
      roleArn: Input<string>;
      input?: Input<string>;
    }

    class Schedule {
      constructor(
        name: string,
        args: {
          scheduleExpression: Input<string>;
          flexibleTimeWindow: ScheduleFlexibleTimeWindow;
          target: ScheduleTarget;
        },
      );
      readonly arn: Output<string>;
      readonly name: Output<string>;
    }
  }

  namespace cognito {
    class UserPoolDomain {
      constructor(name: string, args: { domain: Input<string>; userPoolId: Input<string> });
      readonly domain: Output<string>;
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

    class LogMetricFilter {
      constructor(
        name: string,
        args: {
          logGroupName: Input<string>;
          pattern: string;
          metricTransformation: {
            name: string;
            namespace: string;
            value: string;
            defaultValue?: number;
          };
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
