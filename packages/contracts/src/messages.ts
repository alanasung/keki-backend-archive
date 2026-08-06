import { z } from 'zod';

// Every queue message carries this envelope so Phase 2 can evolve payloads
// without breaking already-deployed consumers: `version` lets a handler
// branch on shape, `occurredAt` is when the event happened (not when it was
// enqueued or delivered).
export interface QueueMessage<TType extends string, TPayload> {
  readonly version: 1;
  readonly type: TType;
  readonly occurredAt: string; // ISO 8601
  readonly payload: TPayload;
}

function queueMessageSchema<TType extends string, TPayloadSchema extends z.ZodTypeAny>(
  type: TType,
  payloadSchema: TPayloadSchema,
) {
  return z.object({
    version: z.literal(1),
    type: z.literal(type),
    occurredAt: z.string().datetime(),
    payload: payloadSchema,
  });
}

export const notificationMessageSchema = queueMessageSchema(
  'notification.drain',
  z.object({ limit: z.number().int().positive().optional() }),
);
export type NotificationMessage = z.infer<typeof notificationMessageSchema>;

export const reconciliationMessageSchema = queueMessageSchema(
  'reconciliation.run',
  z.object({ since: z.string().datetime().optional() }),
);
export type ReconciliationMessage = z.infer<typeof reconciliationMessageSchema>;

// `taskKey` stays a plain, open string here — an unrecognized key from a
// stale EventBridge schedule must still parse so the handler can log and
// drop it gracefully, rather than dead-lettering on an envelope a Zod union
// would otherwise reject outright. KNOWN_TASK_KEYS below is the separate,
// closed set the handler narrows against before its exhaustive switch.
export const scheduledTaskMessageSchema = queueMessageSchema(
  'scheduled.tick',
  z.object({ taskKey: z.string().min(1) }),
);
export type ScheduledTaskMessage = z.infer<typeof scheduledTaskMessageSchema>;

/** Enqueued by the Square HTTP ingress after signature verification. */
export const squareWebhookMessageSchema = queueMessageSchema(
  'square.webhook',
  z.object({
    rawBody: z.string(),
    headers: z.record(z.string(), z.string()),
    verifiedAt: z.string().datetime(), // records that the signature was checked at the boundary
  }),
);
export type SquareWebhookMessage = z.infer<typeof squareWebhookMessageSchema>;

// The closed set of task keys the scheduled-task-worker actually knows how
// to handle. Kept separate from the envelope schema (see above) so the
// worker's switch can be exhaustive over `KnownTaskKey` with a `never`
// default while the envelope itself still accepts any string.
export const KNOWN_TASK_KEYS = ['notification.drain'] as const;
export type KnownTaskKey = (typeof KNOWN_TASK_KEYS)[number];

export function isKnownTaskKey(value: string): value is KnownTaskKey {
  return (KNOWN_TASK_KEYS as readonly string[]).includes(value);
}
