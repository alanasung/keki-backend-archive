import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { reconciliationMessageSchema } from '@keki/contracts';

// TODO(phase-2): This handler is a validated skeleton only. Real
// reconciliation must compare `payment_records` against Square (money source
// of truth) and against reservation state (entitlement source of truth) —
// see docs/vision.md "Scope: Phase 2+". Do not add that logic here yet.
// Not `async` — nothing here awaits anything yet, and the Lambda SQS
// contract only requires returning a `Promise<SQSBatchResponse>`, not that
// the function itself be declared `async`.
export function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      const message = reconciliationMessageSchema.parse(JSON.parse(record.body));
      console.log(
        `reconciliation-worker: received reconciliation.run request${
          message.payload.since !== undefined ? ` since ${message.payload.since}` : ' with no "since" bound'
        }`,
      );
    } catch (error) {
      console.error('reconciliation-worker: failed to process message', error);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return Promise.resolve({ batchItemFailures });
}
