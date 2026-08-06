import { QUEUE_DEFINITIONS, type QueueResources } from "./queues";

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
