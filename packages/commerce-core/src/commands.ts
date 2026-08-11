// TODO(phase-2): Square checkout, payment capture, and refunds land here.
// Every command below already takes a `SquareClient` so the dependency
// direction — commerce-core depends on the interface, never the Square SDK
// (see AGENTS.md "Integrations") — is visible in compiling code even while
// the bodies defer to Phase 2.

import { NotImplementedInPhase1 } from '@keki/contracts';
import type { OrderId, PaymentRecord, SquareClient } from '@keki/contracts';

export function startCheckout(input: {
  squareClient: SquareClient;
  orderId: OrderId;
  currency: string;
}): Promise<{ checkoutUrl: string; squareOrderId: string }> {
  void input;
  return Promise.reject(new NotImplementedInPhase1('startCheckout'));
}

export function capturePayment(input: {
  squareClient: SquareClient;
  providerPaymentId: string;
}): Promise<PaymentRecord> {
  void input;
  return Promise.reject(new NotImplementedInPhase1('capturePayment'));
}

export function refundPayment(input: {
  squareClient: SquareClient;
  providerPaymentId: string;
  amountCents: number;
}): Promise<{ refundId: string }> {
  void input;
  return Promise.reject(new NotImplementedInPhase1('refundPayment'));
}
