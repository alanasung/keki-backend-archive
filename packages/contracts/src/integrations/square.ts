import { z } from 'zod';
import type { OrderId } from '../ids';
import type { PaymentRecord } from '../entities';

export interface SquareCatalogItem {
  readonly squareCatalogObjectId: string;
  readonly squareVariationId: string;
  readonly name: string;
  readonly description: string | null;
  readonly priceCents: number;
  readonly currency: string;
}

export interface SquareCheckoutLineItem {
  readonly name: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
}

export interface SquareClient {
  listCatalogItems(input?: { cursor?: string }): Promise<{
    items: readonly SquareCatalogItem[];
    cursor: string | null;
  }>;
  // Takes an order id plus line items rather than a reservationId — a cafe
  // order has no reservation. Returns squareOrderId, not providerPaymentId:
  // no payment exists at checkout-creation time, Square creates it when the
  // customer pays, and its id arrives on the webhook.
  createCheckout(input: {
    orderId: OrderId;
    lineItems: readonly SquareCheckoutLineItem[];
    currency: string;
    idempotencyKey: string;
    redirectUrl: string;
  }): Promise<{ checkoutUrl: string; squareOrderId: string }>;
  getPayment(input: { providerPaymentId: string }): Promise<PaymentRecord | null>;
  refundPayment(input: {
    providerPaymentId: string;
    amountCents: number;
    idempotencyKey: string;
  }): Promise<{ refundId: string }>;
  // Square's HMAC covers the notification URL concatenated with the body;
  // without notificationUrl, the same signed body replays against a
  // different endpoint.
  verifyWebhookSignature(input: {
    rawBody: string;
    signature: string;
    notificationUrl: string;
  }): Promise<boolean>;
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
