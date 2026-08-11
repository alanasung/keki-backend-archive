// TODO(phase-2): Payment capture and refunds land here. capturePayment and
// refundPayment already take a `SquareClient` so the dependency direction —
// commerce-core depends on the interface, never the Square SDK (see
// AGENTS.md "Integrations") — is visible in compiling code even while their
// bodies defer to a later phase. PAID is terminal; refunds are out of scope
// (see @keki/contracts ORDER_TRANSITIONS).

import { NotImplementedInPhase1 } from '@keki/contracts';
import type { OrderId, PaymentRecord, SquareClient } from '@keki/contracts';
import { InvalidOrderTransitionError, OrderNotFoundError } from './errors';
import { transitionOrder } from './order-state';
import { getOrderWithLineItems } from './queries';

export async function startCheckout(input: {
  squareClient: SquareClient;
  orderId: OrderId;
  redirectUrl: string;
}): Promise<{ checkoutUrl: string; squareOrderId: string }> {
  const found = await getOrderWithLineItems(input.orderId);
  if (found === null) {
    throw new OrderNotFoundError(input.orderId);
  }
  const { order, lineItems } = found;

  if (order.status !== 'DRAFT' && order.status !== 'AWAITING_PAYMENT') {
    throw new InvalidOrderTransitionError(order.id, order.status, 'AWAITING_PAYMENT');
  }

  // Double-submit mitigation: a double-click must reach the same payment
  // link, not create a second one. Status and these two fields are always
  // written together in the single UPDATE below, so AWAITING_PAYMENT with a
  // null squareCheckoutUrl is not a reachable state.
  if (order.squareOrderId !== null && order.squareCheckoutUrl !== null) {
    return { checkoutUrl: order.squareCheckoutUrl, squareOrderId: order.squareOrderId };
  }

  // Line items are built from the persisted rows, never from caller input —
  // the persisted rows are what the customer reviewed. A SquareApiError
  // propagates unwrapped here and the order is left DRAFT/AWAITING_PAYMENT so
  // a retry can succeed; it must never be marked failed on a transient
  // outage.
  const { checkoutUrl, squareOrderId } = await input.squareClient.createCheckout({
    orderId: order.id,
    lineItems: lineItems.map((lineItem) => ({
      name: lineItem.nameSnapshot,
      quantity: lineItem.quantity,
      unitPriceCents: lineItem.unitPriceCents,
    })),
    currency: order.currency,
    idempotencyKey: order.id,
    redirectUrl: input.redirectUrl,
  });

  await transitionOrder({
    orderId: order.id,
    to: 'AWAITING_PAYMENT',
    patch: { squareOrderId, squareCheckoutUrl: checkoutUrl },
  });

  return { checkoutUrl, squareOrderId };
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
