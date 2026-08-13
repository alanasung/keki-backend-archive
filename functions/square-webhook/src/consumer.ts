import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { z } from 'zod';
import {
  squareWebhookEnvelopeSchema,
  squareWebhookMessageSchema,
  type ScheduledTaskMessage,
  type SquareWebhookEnvelope,
} from '@keki/contracts';
import { mapSquarePaymentStatus } from '@keki/square-client';
import { fulfillPayment } from './fulfillment';

// The real Square payment shape, replacing the Phase 1 placeholder that
// invented `household_id` and `reservation_id` — a real Square payment
// webhook carries neither. `order_id` is the Square order id checkout
// captured at startCheckout time (orders.squareOrderId); that is the only
// reference this handler trusts to resolve identity. `status` is left as a
// raw string here — Square's own vocabulary (APPROVED/PENDING/COMPLETED/
// CANCELED/FAILED) — and translated via mapSquarePaymentStatus, which
// throws on a value it does not recognize rather than silently coercing it.
const squarePaymentPayloadSchema = z.object({
  id: z.string(),
  status: z.string(),
  amount_money: z.object({
    amount: z.number().int(),
    currency: z.string(),
  }),
  order_id: z.string().optional(),
  reference_id: z.string().optional(),
});

const sqsClient = new SQSClient({});

function getScheduledTaskQueueUrl(): string {
  const url = process.env['SCHEDULED_TASK_QUEUE_URL'];
  if (url === undefined || url === '') {
    throw new Error('square-webhook consumer: SCHEDULED_TASK_QUEUE_URL is not configured.');
  }
  return url;
}

// catalog.version.updated invalidates the catalog cache by asking the
// scheduled-task-worker to run the sync it already knows how to do — the
// same envelope shape EventBridge uses, not a second message shape.
async function enqueueCatalogSync(): Promise<void> {
  const message: ScheduledTaskMessage = {
    version: 1,
    type: 'scheduled.tick',
    occurredAt: new Date().toISOString(),
    payload: { taskKey: 'catalog.sync' },
  };

  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: getScheduledTaskQueueUrl(),
      MessageBody: JSON.stringify(message),
    }),
  );
}

async function handlePaymentEvent(webhookEnvelope: SquareWebhookEnvelope): Promise<void> {
  const paymentPayload = squarePaymentPayloadSchema.parse(webhookEnvelope.data.object);

  if (paymentPayload.order_id === undefined) {
    // No Square order reference at all — most likely a register sale this
    // system never created. fulfillPayment's own unmatched-order path
    // covers a *wrong* order_id; this covers a missing one.
    console.warn(
      `square-webhook consumer: payment "${paymentPayload.id}" carries no order_id; acknowledging without action.`,
    );
    return;
  }

  await fulfillPayment({
    squareOrderId: paymentPayload.order_id,
    providerPaymentId: paymentPayload.id,
    amountCents: paymentPayload.amount_money.amount,
    currency: paymentPayload.amount_money.currency,
    status: mapSquarePaymentStatus(paymentPayload.status),
    rawPayload: webhookEnvelope.data.object,
    occurredAt: new Date(webhookEnvelope.created_at),
  });
}

// Drains SquareWebhookQueue. The envelope was already verified at the HTTP
// boundary (http.ts) — `verifiedAt` records that, but this handler must
// never re-derive trust from the payload itself, only validate its shape.
export async function queueHandler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      const envelope = squareWebhookMessageSchema.parse(JSON.parse(record.body));
      const webhookEnvelope = squareWebhookEnvelopeSchema.parse(JSON.parse(envelope.payload.rawBody));

      switch (webhookEnvelope.type) {
        case 'payment.created':
        case 'payment.updated':
          await handlePaymentEvent(webhookEnvelope);
          break;
        case 'catalog.version.updated':
          await enqueueCatalogSync();
          break;
        default:
          // Square sends event types we did not subscribe to. Treating an
          // unrecognized type as a failure would fill the DLQ and fire the
          // alarm for normal traffic, the same reasoning the scheduled-task
          // worker applies to unknown task keys.
          console.log(`square-webhook consumer: acknowledging unhandled event type "${webhookEnvelope.type}".`);
          break;
      }
    } catch (error) {
      console.error('square-webhook consumer: failed to process message', error);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}
