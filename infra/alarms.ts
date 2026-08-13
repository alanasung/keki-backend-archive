import { QUEUE_DEFINITIONS, type QueueResources } from "./queues";

// WS-11 step 6: once the webhook Function URL is public (SC-11), a burst of
// signature failures is either an attack or a misconfigured
// SquareNotificationUrl — and both are invisible without this alarm, because
// a rejected request (401) never reaches a queue or a DLQ, so none of the
// alarms above would ever see it. `httpHandler` (functions/square-webhook/
// src/http.ts) logs this exact phrase on every verification failure; the
// metric filter below turns that log line into a CloudWatch metric.
export const SIGNATURE_FAILURE_LOG_PATTERN = '"signature verification failed"';
export const SIGNATURE_FAILURE_METRIC_NAMESPACE = "Keki/SquareWebhook";
export const SIGNATURE_FAILURE_METRIC_NAME = "SignatureVerificationFailures";
export const SIGNATURE_FAILURE_ALARM_NAME = "SquareWebhookSignatureFailureAlarm";
// Threshold and period are a judgment call, not derived from anything else —
// a handful of genuine retries after a rotated key should not page anyone,
// but a sustained burst should.
export const SIGNATURE_FAILURE_ALARM_THRESHOLD = 5;
export const SIGNATURE_FAILURE_ALARM_PERIOD_SECONDS = 5 * 60;
export const SIGNATURE_FAILURE_ALARM_EVALUATION_PERIODS = 1;

// SQS publishes no data points for an empty queue, so every alarm here sets
// `treatMissingData: "notBreaching"` — the default treatment would leave
// every alarm permanently `INSUFFICIENT_DATA`, which reads as broken
// monitoring rather than a healthy, idle queue.
export interface AlarmDefinition {
  readonly name: string;
  /** Matches a `QueueDefinition.name` or `.dlqName` this alarm watches. */
  readonly queueRefName: string;
  readonly metricName: "ApproximateNumberOfMessagesVisible" | "ApproximateAgeOfOldestMessage";
  readonly threshold: number;
  readonly comparisonOperator: "GreaterThanOrEqualToThreshold" | "GreaterThanThreshold";
  readonly evaluationPeriods: number;
  readonly treatMissingData: "notBreaching";
}

export const ALARM_DEFINITIONS: readonly AlarmDefinition[] = QUEUE_DEFINITIONS.flatMap((definition) => [
  {
    name: `${definition.dlqName}MessagesVisibleAlarm`,
    queueRefName: definition.dlqName,
    metricName: "ApproximateNumberOfMessagesVisible",
    threshold: 1,
    comparisonOperator: "GreaterThanOrEqualToThreshold",
    evaluationPeriods: 1,
    treatMissingData: "notBreaching",
  },
  {
    name: `${definition.name}OldestMessageAgeAlarm`,
    queueRefName: definition.name,
    metricName: "ApproximateAgeOfOldestMessage",
    threshold: definition.oldestMessageAgeAlarmThresholdSeconds,
    comparisonOperator: "GreaterThanThreshold",
    evaluationPeriods: 1,
    treatMissingData: "notBreaching",
  },
]);

export interface AlarmResources {
  readonly topic: aws.sns.Topic;
  readonly alarms: readonly aws.cloudwatch.MetricAlarm[];
}

export interface SignatureFailureAlarmResources {
  readonly metricFilter: aws.cloudwatch.LogMetricFilter;
  readonly alarm: aws.cloudwatch.MetricAlarm;
}

// `squareWebhookHttp.name` is the physical Lambda function name; Lambda
// creates its CloudWatch Log Group at `/aws/lambda/<function name>`
// automatically, so no separate log group needs constructing here.
export function createSignatureFailureAlarm(
  squareWebhookHttp: sst.aws.Function,
  topic: aws.sns.Topic,
): SignatureFailureAlarmResources {
  const logGroupName = squareWebhookHttp.name.apply((name) => `/aws/lambda/${name}`);

  const metricFilter = new aws.cloudwatch.LogMetricFilter("SquareWebhookSignatureFailureFilter", {
    logGroupName,
    pattern: SIGNATURE_FAILURE_LOG_PATTERN,
    metricTransformation: {
      name: SIGNATURE_FAILURE_METRIC_NAME,
      namespace: SIGNATURE_FAILURE_METRIC_NAMESPACE,
      value: "1",
      defaultValue: 0,
    },
  });

  const alarm = new aws.cloudwatch.MetricAlarm(SIGNATURE_FAILURE_ALARM_NAME, {
    namespace: SIGNATURE_FAILURE_METRIC_NAMESPACE,
    metricName: SIGNATURE_FAILURE_METRIC_NAME,
    dimensions: {},
    statistic: "Sum",
    period: SIGNATURE_FAILURE_ALARM_PERIOD_SECONDS,
    evaluationPeriods: SIGNATURE_FAILURE_ALARM_EVALUATION_PERIODS,
    threshold: SIGNATURE_FAILURE_ALARM_THRESHOLD,
    comparisonOperator: "GreaterThanOrEqualToThreshold",
    treatMissingData: "notBreaching",
    alarmActions: [topic.arn],
  });

  return { metricFilter, alarm };
}

export function createAlarms(resources: QueueResources): AlarmResources {
  // Subscribing a real endpoint (email/Slack/PagerDuty) is Phase 2; this
  // topic exists so the alarms have a target.
  const topic = new aws.sns.Topic("QueueAlarmsTopic");
  const allQueues: Record<string, sst.aws.Queue> = { ...resources.queues, ...resources.dlqs };

  const alarms = ALARM_DEFINITIONS.map((definition) => {
    const queue = allQueues[definition.queueRefName];
    if (queue === undefined) {
      throw new Error(`No queue named "${definition.queueRefName}" for alarm "${definition.name}".`);
    }

    return new aws.cloudwatch.MetricAlarm(definition.name, {
      namespace: "AWS/SQS",
      metricName: definition.metricName,
      dimensions: { QueueName: queue.name },
      statistic: "Maximum",
      period: 300,
      evaluationPeriods: definition.evaluationPeriods,
      threshold: definition.threshold,
      comparisonOperator: definition.comparisonOperator,
      treatMissingData: definition.treatMissingData,
      alarmActions: [topic.arn],
    });
  });

  return { topic, alarms };
}
