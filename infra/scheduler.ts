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
