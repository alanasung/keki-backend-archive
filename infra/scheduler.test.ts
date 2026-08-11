import { scheduledTaskMessageSchema } from "@keki/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import type { QueueResources } from "./queues";
import {
  SCHEDULE_DEFINITIONS,
  SCHEDULER_ROLE_NAME,
  buildScheduledTaskMessage,
  createSchedules,
} from "./scheduler";

// WS-11 test 10: both schedules exist with their intervals.
describe("SCHEDULE_DEFINITIONS", () => {
  it("declares catalog.sync every 15 minutes", () => {
    const catalogSync = SCHEDULE_DEFINITIONS.find((d) => d.taskKey === "catalog.sync");
    expect(catalogSync).toBeDefined();
    expect(catalogSync?.rateMinutes).toBe(15);
  });

  it("declares reservation.expire-holds every 5 minutes", () => {
    const expireHolds = SCHEDULE_DEFINITIONS.find((d) => d.taskKey === "reservation.expire-holds");
    expect(expireHolds).toBeDefined();
    expect(expireHolds?.rateMinutes).toBe(5);
  });

  it("declares exactly these two schedules", () => {
    expect(SCHEDULE_DEFINITIONS.map((d) => d.taskKey).sort()).toEqual(
      ["catalog.sync", "reservation.expire-holds"].sort(),
    );
  });

  // WS-11 test 11: the hold TTL is 15 minutes (reservation-core); a sweep
  // slower than that would leave seats unsellable well past expiry.
  it("sweeps holds strictly more often than the 15-minute hold TTL", () => {
    const expireHolds = SCHEDULE_DEFINITIONS.find((d) => d.taskKey === "reservation.expire-holds");
    expect(expireHolds?.rateMinutes).toBeLessThan(15);
  });
});

// WS-11 test 13: schedule payloads match the worker's envelope.
describe("buildScheduledTaskMessage", () => {
  it("produces a message the worker's scheduledTaskMessageSchema parses", () => {
    for (const definition of SCHEDULE_DEFINITIONS) {
      const message = buildScheduledTaskMessage(definition.taskKey);
      expect(() => scheduledTaskMessageSchema.parse(message)).not.toThrow();

      const parsed = scheduledTaskMessageSchema.parse(message);
      expect(parsed.type).toBe("scheduled.tick");
      expect(parsed.payload.taskKey).toBe(definition.taskKey);
    }
  });

  it("does not invent a second message shape", () => {
    const message = buildScheduledTaskMessage("catalog.sync", "2026-01-01T00:00:00.000Z");
    expect(message).toEqual({
      version: 1,
      type: "scheduled.tick",
      occurredAt: "2026-01-01T00:00:00.000Z",
      payload: { taskKey: "catalog.sync" },
    });
  });
});

// Exercises the real `createSchedules` wiring against hand-built fakes for
// the `aws` global SST's CLI would otherwise inject — mirrors the pattern
// queues.test.ts uses for `attachWorkers`.
describe("createSchedules (WS-11 test 12)", () => {
  class FakeSchedule {
    readonly arn = "arn:aws:scheduler:us-west-2:000000000000:schedule/default/fake";
    readonly name: string;
    readonly args: unknown;
    constructor(name: string, args: unknown) {
      this.name = name;
      this.args = args;
    }
  }

  beforeAll(() => {
    (globalThis as Record<string, unknown>)["aws"] = {
      ...(globalThis as Record<string, unknown>)["aws"] as Record<string, unknown>,
      scheduler: { Schedule: FakeSchedule },
    };
  });

  function buildResources(): QueueResources {
    const scheduledTaskQueue = {
      name: "ScheduledTaskQueue",
      arn: "arn:aws:sqs:us-west-2:000000000000:ScheduledTaskQueue",
      url: "https://sqs.us-west-2.amazonaws.com/000000000000/ScheduledTaskQueue",
    } as unknown as sst.aws.Queue;

    return { queues: { ScheduledTaskQueue: scheduledTaskQueue }, dlqs: {} };
  }

  const fakeRole = { id: "role-id", arn: "arn:aws:iam::000000000000:role/SchedulerExecutionRole" } as unknown as aws.iam.Role;

  it("targets ScheduledTaskQueue through the existing execution role", () => {
    const resources = buildResources();
    const schedules = createSchedules(resources, fakeRole);

    expect(schedules).toHaveLength(SCHEDULE_DEFINITIONS.length);
    for (const schedule of schedules) {
      const fake = schedule as unknown as FakeSchedule;
      const args = fake.args as { target: { arn: string; roleArn: string } };
      expect(args.target.arn).toBe(resources.queues.ScheduledTaskQueue?.arn);
      expect(args.target.roleArn).toBe(fakeRole.arn);
    }
  });

  it("uses the same execution role name createSchedulerRole creates", () => {
    expect(SCHEDULER_ROLE_NAME).toBe("SchedulerExecutionRole");
  });

  it("sends the versioned envelope as the schedule input", () => {
    const resources = buildResources();
    const schedules = createSchedules(resources, fakeRole);

    for (const [index, schedule] of schedules.entries()) {
      const fake = schedule as unknown as FakeSchedule;
      const args = fake.args as { target: { input: string } };
      const parsed: unknown = JSON.parse(args.target.input);
      expect(() => scheduledTaskMessageSchema.parse(parsed)).not.toThrow();
      expect((parsed as { payload: { taskKey: string } }).payload.taskKey).toBe(
        SCHEDULE_DEFINITIONS[index]?.taskKey,
      );
    }
  });

  it("sets the rate expression from each definition's interval", () => {
    const resources = buildResources();
    const schedules = createSchedules(resources, fakeRole);

    for (const [index, schedule] of schedules.entries()) {
      const fake = schedule as unknown as FakeSchedule;
      const args = fake.args as { scheduleExpression: string };
      expect(args.scheduleExpression).toBe(`rate(${SCHEDULE_DEFINITIONS[index]?.rateMinutes} minutes)`);
    }
  });
});
