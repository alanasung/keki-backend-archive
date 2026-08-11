import type { SquareClient as SquareSdkClient, Currency } from 'square';
import type { OrderId, SquareCheckoutLineItem } from '@keki/contracts';

// Every Square Order requires a location id, but SquareConfig deliberately
// carries only the four credential fields the workstream spec defines (a
// second cafe location is out of scope for Phase 2). Resolving it from the
// account's own locations keeps the config surface exactly as specified, at
// the cost of one extra API call per checkout — negligible at cafe order
// volume.
async function resolveLocationId(sdk: SquareSdkClient): Promise<string> {
  const response = await sdk.locations.list();
  const locations = response.locations ?? [];
  const location = locations.find((candidate) => candidate.status === 'ACTIVE') ?? locations[0];

  if (location?.id === undefined) {
    throw new Error('createCheckout: the Square account has no location to create a payment link against.');
  }

  return location.id;
}

export async function createCheckout(
  sdk: SquareSdkClient,
  input: {
    orderId: OrderId;
    lineItems: readonly SquareCheckoutLineItem[];
    currency: string;
    idempotencyKey: string;
    redirectUrl: string;
  },
): Promise<{ checkoutUrl: string; squareOrderId: string }> {
  const locationId = await resolveLocationId(sdk);

  const response = await sdk.checkout.paymentLinks.create({
    idempotencyKey: input.idempotencyKey,
    order: {
      locationId,
      // WS-10 resolves the order from this reference id. A real Square
      // payment webhook carries no household_id or reservation_id of its
      // own (see functions/square-webhook/src/consumer.ts's
      // TODO(phase-2)) — this is what replaces that placeholder with
      // something real.
      referenceId: input.orderId,
      lineItems: input.lineItems.map((lineItem) => ({
        name: lineItem.name,
        quantity: String(lineItem.quantity),
        basePriceMoney: {
          amount: BigInt(lineItem.unitPriceCents),
          // SquareCheckoutLineItem's currency is a plain string at the
          // contracts boundary; Square's SDK narrows it to its own ISO
          // 4217 literal union.
          currency: input.currency as Currency,
        },
      })),
    },
    checkoutOptions: {
      redirectUrl: input.redirectUrl,
    },
  });

  const checkoutUrl = response.paymentLink?.url;
  const squareOrderId = response.paymentLink?.orderId;

  // No payment id is fabricated here — none exists until the customer
  // pays. Square creates it and delivers it on the webhook.
  if (checkoutUrl === undefined || squareOrderId === undefined) {
    throw new Error('createCheckout: Square did not return a usable payment link.');
  }

  return { checkoutUrl, squareOrderId };
}
