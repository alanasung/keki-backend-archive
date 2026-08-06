import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { z } from 'zod';
import {
  PAYMENT_STATUSES,
  createHouseholdId,
  createReservationId,
  squareWebhookEnvelopeSchema,
  squareWebhookMessageSchema,
} from '@keki/contracts';
import { recordPaymentFromWebhook } from '@keki/commerce-core';

// TODO(phase-2): A real Square payment webhook carries no `household_id` or
// `reservation_id` — those must be resolved from the order/reference
// metadata Square echoes back from checkout, which Phase 1 does not
// implement (see AGENTS.md and WS-11 step 6's SC-11 exception: signature
// verification only, no checkout/capture/refund logic). This schema is a
// placeholder shape, sufficient to prove the enqueue -> verify -> consume ->
// record wiring end to end, that a real Square payload does not have.
const squarePaymentPayloadSchema = z.object({
  id: z.string(),
  status: z.enum(PAYMENT_STATUSES),
  amount_money: z.object({
    amount: z.number().int(),
    currency: z.string(),
  }),
  household_id: z.string(),
  reservation_id: z.string().optional(),
});

// Drains SquareWebhookQueue. The envelope was already verified at the HTTP
// boundary (http.ts) — `verifiedAt` records that, but this handler must
// never re-derive trust from the payload itself, only validate its shape.
export async function queueHandler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      const envelope = squareWebhookMessageSchema.parse(JSON.parse(record.body));
      const webhookEnvelope = squareWebhookEnvelopeSchema.parse(JSON.parse(envelope.payload.rawBody));
      const paymentPayload = squarePaymentPayloadSchema.parse(webhookEnvelope.data.object);

      // Idempotent on providerPaymentId, which is what makes Square's
      // webhook redelivery safe — a duplicate delivery lands the same row
      // twice and `created` simply comes back `false` the second time.
      await recordPaymentFromWebhook({
        providerPaymentId: paymentPayload.id,
        householdId: createHouseholdId(paymentPayload.household_id),
        ...(paymentPayload.reservation_id !== undefined
          ? { reservationId: createReservationId(paymentPayload.reservation_id) }
          : {}),
        amountCents: paymentPayload.amount_money.amount,
        currency: paymentPayload.amount_money.currency,
        status: paymentPayload.status,
        rawPayload: webhookEnvelope.data.object,
        occurredAt: new Date(webhookEnvelope.created_at),
      });
    } catch (error) {
      console.error('square-webhook consumer: failed to process message', error);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}
