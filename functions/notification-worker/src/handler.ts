import type { Context, SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { notificationMessageSchema } from '@keki/contracts';
import {
  claimDueNotifications,
  createNoopProviders,
  dispatchNotification,
  markNotificationFailed,
  markNotificationSent,
  reclaimStaleClaims,
} from '@keki/notification-core';

const RECLAIM_WINDOW_MS = 900_000; // 15 minutes
const DEFAULT_CLAIM_LIMIT = 25;

// Resolved eagerly at module load, not inside the handler, so a Lambda
// deployed with NODE_ENV=production and no KEKI_ALLOW_NOOP_PROVIDERS
// override fails at cold start rather than on first invocation — a silent
// no-op in production is a customer-communication outage that reports
// success.
const providers = createNoopProviders();

export async function handler(event: SQSEvent, context: Context): Promise<SQSBatchResponse> {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  // Runs once per invocation, before any claim, so rows abandoned by a
  // timed-out worker are recovered to PENDING and eligible for this same
  // invocation's claim query rather than sitting in CLAIMED forever.
  const reclaimed = await reclaimStaleClaims({ olderThanMs: RECLAIM_WINDOW_MS });
  if (reclaimed > 0) {
    console.warn(`notification-worker: reclaimed ${reclaimed} stale claim(s).`);
  }

  for (const record of event.Records) {
    try {
      const message = notificationMessageSchema.parse(JSON.parse(record.body));
      const limit = message.payload.limit ?? DEFAULT_CLAIM_LIMIT;

      const entries = await claimDueNotifications({ limit, claimedBy: context.awsRequestId });

      // A single entry's dispatch failure must not fail the batch: caught
      // per entry and settled via markNotificationFailed, never rethrown.
      for (const entry of entries) {
        try {
          await dispatchNotification({ entry, providers });
          await markNotificationSent({ id: entry.id });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          await markNotificationFailed({ id: entry.id, error: errorMessage });
        }
      }
    } catch (error) {
      console.error('notification-worker: failed to process message', error);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}
