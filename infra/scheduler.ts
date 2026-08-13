import type { ScheduledTaskMessage } from "@keki/contracts";
import type { QueueResources } from "./queues";

export const SCHEDULER_ROLE_NAME = "SchedulerExecutionRole";

// Pure builders so the policy shape can be asserted on without constructing
// any AWS resource. Scope the resource ARN narrowly — never `sqs:*` on `*`.
export function buildSchedulerTrustPolicy(): Record<string, unknown> {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "scheduler.amazonaws.com" },
        Action: "sts:AssumeRole",
      },
    ],
  };
}

export function buildSchedulerPolicyDocument(scheduledTaskQueueArn: string): Record<string, unknown> {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: "sqs:SendMessage",
        Resource: scheduledTaskQueueArn,
      },
    ],
  };
}

export function createSchedulerRole(resources: QueueResources): aws.iam.Role {
  const scheduledTaskQueue = resources.queues.ScheduledTaskQueue;
  if (scheduledTaskQueue === undefined) {
    throw new Error('No "ScheduledTaskQueue" among the created queues.');
  }

  const role = new aws.iam.Role(SCHEDULER_ROLE_NAME, {
    assumeRolePolicy: JSON.stringify(buildSchedulerTrustPolicy()),
  });

  new aws.iam.RolePolicy(`${SCHEDULER_ROLE_NAME}Policy`, {
    role: role.id,
    policy: scheduledTaskQueue.arn.apply((arn) => JSON.stringify(buildSchedulerPolicyDocument(arn))),
  });

  return role;
}

// ---------------------------------------------------------------------------
// WS-11 step 5: the two EventBridge Scheduler schedules that keep the
// program running without a human triggering it — `catalog.sync` bounds
// catalog staleness (the mitigation named in the program's risk register)
// and `reservation.expire-holds` reclaims abandoned seats. Both target
// `ScheduledTaskQueue` through `createSchedulerRole`'s execution role above
// and send the same versioned envelope `scheduled-task-worker` already
// parses (`scheduledTaskMessageSchema`) — no second message shape.
// ---------------------------------------------------------------------------

export interface ScheduleDefinition {
  readonly name: string;
  readonly taskKey: string;
  readonly rateMinutes: number;
}

// The hold TTL is 15 minutes (reservation-core); a sweep slower than that
// would leave seats unsellable well past expiry, so the sweep interval must
// stay strictly less than it.
const HOLD_TTL_MINUTES = 15;

export const SCHEDULE_DEFINITIONS: readonly ScheduleDefinition[] = [
  { name: "CatalogSyncSchedule", taskKey: "catalog.sync", rateMinutes: 15 },
  { name: "ExpireHoldsSchedule", taskKey: "reservation.expire-holds", rateMinutes: HOLD_TTL_MINUTES / 3 },
];

// Pure so the payload can be asserted against `scheduledTaskMessageSchema`
// without constructing any AWS resource (test 13). `occurredAt` is fixed at
// synthesis time — EventBridge Scheduler's target `input` is a static
// string set when the schedule is created, not templated per firing, and
// the worker (`functions/scheduled-task-worker/src/handler.ts`) never reads
// it for these task keys, only `payload.taskKey`.
export function buildScheduledTaskMessage(taskKey: string, occurredAt: string = new Date().toISOString()): ScheduledTaskMessage {
  return {
    version: 1,
    type: "scheduled.tick",
    occurredAt,
    payload: { taskKey },
  };
}

export function createSchedules(
  resources: QueueResources,
  schedulerRole: aws.iam.Role,
): readonly aws.scheduler.Schedule[] {
  const scheduledTaskQueue = resources.queues.ScheduledTaskQueue;
  if (scheduledTaskQueue === undefined) {
    throw new Error('No "ScheduledTaskQueue" among the created queues.');
  }

  return SCHEDULE_DEFINITIONS.map(
    (definition) =>
      new aws.scheduler.Schedule(definition.name, {
        scheduleExpression: `rate(${definition.rateMinutes} minutes)`,
        flexibleTimeWindow: { mode: "OFF" },
        target: {
          arn: scheduledTaskQueue.arn,
          roleArn: schedulerRole.arn,
          input: JSON.stringify(buildScheduledTaskMessage(definition.taskKey)),
        },
      }),
  );
}
