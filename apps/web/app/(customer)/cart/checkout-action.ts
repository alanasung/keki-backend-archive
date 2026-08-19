'use server';

import {
  createOrder,
  ParticipantNotInHouseholdError,
  startCheckout,
  transitionOrder,
} from '@keki/commerce-core';
import type { Session } from '@keki/auth';
import type { OrderId } from '@keki/contracts';
import { z } from 'zod';
import { authenticatedAction } from '../../actions/authenticated-action';
import { EmptyCartError, StaleCartParticipantError } from '../../actions/errors';
import { getSeatHolder, getSquareClient } from '../../server-clients';
import { clearCart, readCart } from './cart-cookie';

// No fields: the cart cookie is the only state this action reads, never the
// request payload (see readCart below). A plain (non-strict) empty object
// schema parses successfully and silently drops any extra keys a caller
// sends, so a body carrying a `cart` field is ignored rather than rejected —
// that is the point, not an oversight.
const checkoutSchema = z.object({});

function appBaseUrl(): string {
  const base = process.env['APP_BASE_URL'];
  if (base === undefined || base.length === 0) {
    throw new Error(
      'APP_BASE_URL is required to build the Square checkout redirect. It must come from server ' +
        'configuration, never from a request header — see sanitizeNextPath in app/auth/guards.ts for ' +
        'why a header-derived redirect is unsafe.',
    );
  }
  return base;
}

export const checkoutAction = authenticatedAction({
  schema: checkoutSchema,
  async handler(_input, session: Session): Promise<{ checkoutUrl: string }> {
    const cart = await readCart();
    if (cart.lines.length === 0) {
      throw new EmptyCartError();
    }

    // Every authenticated CustomerProfile is expected to belong to a
    // household (docs/vision.md: "Household: the billing and grouping
    // unit"); createOrder requires a non-null one. This should be
    // unreachable in practice — surfaced as INTERNAL, not a customer-facing
    // validation message, because it reflects a profile-provisioning bug,
    // not anything the customer did.
    const householdId = session.profile.householdId;
    if (householdId === null) {
      throw new Error('checkoutAction: authenticated session has no household.');
    }

    // createOrder holds every class seat inside its own transaction (WS-05);
    // this action never calls holdReservation directly, so an order and its
    // seat holds either both land or neither does.
    let orderId: OrderId;
    try {
      const { order } = await createOrder({
        cart,
        householdId,
        createdByCustomerId: session.profile.customerId,
        seatHolder: getSeatHolder(),
      });
      orderId = order.id;
    } catch (error) {
      // WS-09's cart actions already reject a foreign participant when it is
      // added to the cart; reaching this catch means household membership
      // changed since — a stale cart, not a fresh input mistake. Rethrown as
      // a distinct type so errors.ts maps it to CONFLICT instead of the
      // VALIDATION it maps ParticipantNotInHouseholdError to elsewhere.
      if (error instanceof ParticipantNotInHouseholdError) {
        throw new StaleCartParticipantError(error.participant);
      }
      throw error;
    }

    // Built from server configuration, never a request header — a
    // Host-derived redirect is attacker-controllable and would send a
    // paying customer to another origin after checkout.
    const redirectUrl = `${appBaseUrl()}/orders/${orderId}`;

    // Demo path: send the customer to the local mock checkout instead of
    // Square. Square's hosted page works fine, but the payment it completes
    // is only reflected back through a webhook, and Square cannot deliver
    // one to localhost — so a local demo would strand every order at
    // AWAITING_PAYMENT. The mock page performs the same transitions the
    // webhook consumer performs.
    //
    // Refused in production by both conditions, and the order is left
    // AWAITING_PAYMENT exactly as the Square path leaves it.
    if (process.env['NODE_ENV'] !== 'production' && process.env['KEKI_ENABLE_MOCK_CHECKOUT'] === 'true') {
      await transitionOrder({ orderId, to: 'AWAITING_PAYMENT', expect: 'DRAFT' });
      await clearCart();
      return { checkoutUrl: `${appBaseUrl()}/checkout/mock/${orderId}` };
    }

    // A SquareApiError here propagates unwrapped (mapped to UNAVAILABLE by
    // errors.ts) and the order is left DRAFT/AWAITING_PAYMENT for a retry —
    // the cart cookie below is deliberately not cleared until this succeeds.
    const { checkoutUrl } = await startCheckout({
      squareClient: getSquareClient(),
      orderId,
      redirectUrl,
    });

    // Cleared only now: clearing before startCheckout succeeds would lose
    // the customer's participant selections on a Square outage.
    await clearCart();

    return { checkoutUrl };
  },
});
