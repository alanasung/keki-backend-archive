import {
  getOrderBySquareOrderId,
  getOrderWithLineItems,
  recordPaymentFromWebhook,
  transitionOrder,
} from '@keki/commerce-core';
import { confirmReservation, InvalidReservationTransitionError } from '@keki/reservation-core';
import { enqueueNotification } from '@keki/notification-core';
import type { OrderId, PaymentStatus } from '@keki/contracts';

function getStaffAlertEmail(): string {
  const address = process.env['STAFF_ALERT_EMAIL'];
  if (address === undefined || address === '') {
    throw new Error('fulfillPayment: STAFF_ALERT_EMAIL is not configured.');
  }
  return address;
}

// The webhook signature makes the message authentic; it does not make its
// contents authoritative about our internal ids. Order identity always comes
// from our own database, keyed by the Square order id checkout captured
// (startCheckout -> orders.squareOrderId), never from a payload field a
// forged webhook body could set to anything.
export async function fulfillPayment(input: {
  squareOrderId: string;
  providerPaymentId: string;
  amountCents: number;
  currency: string;
  status: PaymentStatus;
  rawPayload: Record<string, unknown>;
  occurredAt: Date;
}): Promise<{ orderId: OrderId | null; confirmed: number }> {
  const order = await getOrderBySquareOrderId(input.squareOrderId);
  if (order === null) {
    // Payments can exist for orders taken at the physical register, which
    // this system did not create. That is ordinary cafe business, not a
    // failure, so this acknowledges rather than dead-lettering.
    console.warn(
      `fulfillPayment: no order matches Square order id "${input.squareOrderId}"; acknowledging without action.`,
    );
    return { orderId: null, confirmed: 0 };
  }

  // Idempotent on provider_payment_id, so a redelivered webhook lands the
  // same row twice and `created` simply comes back false the second time.
  await recordPaymentFromWebhook({
    providerPaymentId: input.providerPaymentId,
    householdId: order.householdId,
    amountCents: input.amountCents,
    currency: input.currency,
    status: input.status,
    rawPayload: input.rawPayload,
    occurredAt: input.occurredAt,
  });

  // Only a captured payment earns the order PAID — PENDING or FAILED must
  // never confirm seats.
  if (input.status === 'CAPTURED') {
    await transitionOrder({
      orderId: order.id,
      to: 'PAID',
      expect: 'AWAITING_PAYMENT',
      patch: { providerPaymentId: input.providerPaymentId },
    });
  }

  // Re-read after the transition attempt and confirm off the order *being*
  // PAID, never off whether this call was the one that changed it. If a
  // crash lands between the transition above and the confirmations below,
  // the next (SQS-redelivered) attempt sees transitionOrder report
  // changed: false — because the order is already PAID — and must still
  // finish confirming every outstanding reservation.
  const current = await getOrderWithLineItems(order.id);
  if (current === null || current.order.status !== 'PAID') {
    return { orderId: order.id, confirmed: 0 };
  }

  let confirmed = 0;
  for (const lineItem of current.lineItems) {
    if (lineItem.reservationId === null) {
      continue;
    }

    try {
      // Individually idempotent, so re-running this for an already
      // confirmed seat on a redelivery is free — never skip a line item on
      // the assumption a previous attempt already handled it.
      await confirmReservation({ reservationId: lineItem.reservationId });
      confirmed += 1;
    } catch (error) {
      if (error instanceof InvalidReservationTransitionError) {
        // The hold already expired and was cancelled before the payment
        // landed; the seat may have been resold. Re-holding here could
        // oversell it, so this is surfaced loudly for staff instead of
        // silently swallowed or silently re-held.
        console.error(
          `fulfillPayment: reservation "${lineItem.reservationId}" for order "${order.id}" could not be ` +
            'confirmed because its hold already expired. The payment stands and the order remains PAID ' +
            'pending staff resolution.',
          error,
        );
        await enqueueNotification({
          channel: 'EMAIL',
          templateKey: 'staff.expired-hold-after-payment',
          recipientAddress: getStaffAlertEmail(),
          payload: {
            orderId: order.id,
            reservationId: lineItem.reservationId,
            providerPaymentId: input.providerPaymentId,
          },
        });
        continue;
      }
      throw error;
    }
  }

  return { orderId: order.id, confirmed };
}
