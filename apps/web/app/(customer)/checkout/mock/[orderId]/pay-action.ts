'use server';

import { getOrderWithLineItems, transitionOrder } from '@keki/commerce-core';
import { confirmReservation } from '@keki/reservation-core';
import { createOrderId } from '@keki/contracts';
import { z } from 'zod';
import { authenticatedAction } from '../../../../actions/authenticated-action';

/**
 * Marks a mock-checkout order paid and confirms the seats it holds.
 *
 * This stands in for WS-10's webhook fulfillment, which cannot run locally:
 * Square delivers payment events over the public internet and cannot reach
 * localhost. Rather than leave the demo stranded at AWAITING_PAYMENT, this
 * performs the same two transitions the real consumer performs — order to
 * PAID, then confirm every reservation the order holds.
 *
 * It is NOT a payment integration. No card data is read, transmitted, or
 * stored; the fields on the page are decorative and their values never leave
 * the browser. Real money moves only through Square-hosted checkout.
 */

const paySchema = z.object({ orderId: z.string() });

function assertMockCheckoutEnabled(): void {
  // Two independent conditions, both required. `NODE_ENV === 'production'`
  // alone would be enough on a deployed stage, but the flag makes the
  // capability opt-in even in development, so it cannot be reached by
  // accident on a machine that happens to have the route compiled.
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('Mock checkout is refused in production. Real payments go through Square.');
  }
  if (process.env['KEKI_ENABLE_MOCK_CHECKOUT'] !== 'true') {
    throw new Error('Mock checkout is disabled. Set KEKI_ENABLE_MOCK_CHECKOUT=true to enable it.');
  }
}

export const payMockOrderAction = authenticatedAction({
  schema: paySchema,
  async handler(input, session): Promise<{ orderId: string; confirmed: number }> {
    assertMockCheckoutEnabled();

    const orderId = createOrderId(input.orderId);
    const existing = await getOrderWithLineItems(orderId);
    if (existing === null) {
      throw new Error('Order not found.');
    }

    // Object-level authorization: an order id is a uuid, but that is not a
    // permission. Without this check any signed-in customer could pay — and
    // thereby confirm seats on — another household's order.
    if (existing.order.householdId !== session.profile.householdId) {
      throw new Error('Order not found.');
    }

    // AWAITING_PAYMENT is the only state a payment may complete from; DRAFT
    // means checkout was never started, and PAID means this already ran.
    if (existing.order.status === 'AWAITING_PAYMENT') {
      await transitionOrder({
        orderId,
        to: 'PAID',
        expect: 'AWAITING_PAYMENT',
        patch: { providerPaymentId: `mock-${orderId}` },
      });
    }

    // Confirm whenever the order *is* PAID rather than only when the
    // transition above changed it — the same rule WS-10 follows, so a repeat
    // submit finishes any confirmations a previous attempt left undone
    // instead of skipping them.
    const current = await getOrderWithLineItems(orderId);
    let confirmed = 0;
    if (current !== null && current.order.status === 'PAID') {
      for (const line of current.lineItems) {
        if (line.reservationId !== null) {
          const { changed } = await confirmReservation({ reservationId: line.reservationId });
          if (changed) {
            confirmed += 1;
          }
        }
      }
    }

    return { orderId: input.orderId, confirmed };
  },
});
