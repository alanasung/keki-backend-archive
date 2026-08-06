import { z } from 'zod';
import type { ReservationId } from '../ids';
import type { PaymentRecord } from '../entities';

export interface SquareClient {
  createCheckout(input: {
    reservationId: ReservationId;
    amountCents: number;
    currency: string;
    idempotencyKey: string;
  }): Promise<{ checkoutUrl: string; providerPaymentId: string }>;
  getPayment(input: { providerPaymentId: string }): Promise<PaymentRecord | null>;
  refundPayment(input: {
    providerPaymentId: string;
    amountCents: number;
    idempotencyKey: string;
  }): Promise<{ refundId: string }>;
  verifyWebhookSignature(input: { rawBody: string; signature: string }): Promise<boolean>;
}

// The Square webhook envelope crosses a trust boundary (inbound HTTP from
// Square), so it gets a Zod schema here rather than a plain type.
export const squareWebhookEnvelopeSchema = z.object({
  merchant_id: z.string(),
  type: z.string(),
  event_id: z.string(),
  created_at: z.string(),
  data: z.object({
    type: z.string(),
    id: z.string(),
    object: z.record(z.string(), z.unknown()),
  }),
});
export type SquareWebhookEnvelope = z.infer<typeof squareWebhookEnvelopeSchema>;
