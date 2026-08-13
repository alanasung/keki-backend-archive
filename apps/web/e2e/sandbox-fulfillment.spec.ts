// SC-20: the only test in this program that exercises the real
// payment-to-fulfillment path end to end. Every other test mocks the cores
// or stubs Square (see fixtures/square-stub.ts) — this one creates a real
// order, completes a real Square **sandbox** payment, delivers a genuinely
// signed webhook to a **deployed** square-webhook endpoint, and asserts the
// order reaches PAID with its class reservation CONFIRMED. A genuine
// integration break — a wrong reference field, a signature mismatch, a
// payload shape Square actually sends but the parser rejects — passes every
// other gate in this program and would only ever surface here.
//
// Gated on SQUARE_ACCESS_TOKEN and skipped otherwise. Does not gate CI: it
// needs real credentials, a real deployed square-webhook Function URL
// (SQUARE_NOTIFICATION_URL), and DATABASE_URL_POOLED/DATABASE_URL_DIRECT
// pointing at *that deployed stage's* database — not the ephemeral per-run
// Neon branch the rest of this e2e suite uses — because the deployed
// webhook Lambda and this test must agree on which database "the order"
// lives in. Run manually before a production release; see docs/testing.md
// "Deployed-stage tests" for the same precondition pattern
// (RUN_DEPLOYED_STAGE_TESTS) used elsewhere in this program.
import { createHmac, randomUUID } from 'node:crypto';
import { test } from '@playwright/test';
import { SquareClient as SquareSdkClient, SquareEnvironment } from 'square';
import type { Currency } from 'square';
import { createOrder, getOrderWithLineItems, startCheckout } from '@keki/commerce-core';
import { createSeatHolder, getReservationById } from '@keki/reservation-core';
import { createSquareClient } from '@keki/square-client';
import { customers, db } from '@keki/database';
import { eq } from 'drizzle-orm';
import {
  createChildId,
  createCustomerId,
  createHouseholdId,
  createOccurrenceId,
  type Cart,
  type OrderId,
} from '@keki/contracts';
import { E2E_CHILD, E2E_OCCURRENCE_ID, TEST_USERS } from './fixtures/seed';
import { APP_BASE_URL } from './fixtures/test-env';

const hasSquareCredentials = Boolean(process.env['SQUARE_ACCESS_TOKEN']);

const FULFILLMENT_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 2_000;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `sandbox-fulfillment: ${name} is required for this test (in addition to SQUARE_ACCESS_TOKEN). ` +
        'See docs/testing.md "Deployed-stage tests".',
    );
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Square signs notificationUrl + rawBody with HMAC-SHA256, base64-encoded —
// see packages/square-client/src/verify-signature.ts, whose `verify` side
// this mirrors exactly. Using the real SQUARE_WEBHOOK_SIGNATURE_KEY here is
// what makes this "with its real signature": the deployed endpoint's own
// verifier must accept it, not a bypass.
function signWebhookBody(input: { rawBody: string; notificationUrl: string; signingKey: string }): string {
  return createHmac('sha256', input.signingKey).update(input.notificationUrl + input.rawBody, 'utf8').digest('base64');
}

async function householdAndCustomerId(cognitoSub: string): Promise<{ householdId: string; customerId: string }> {
  const rows = await db
    .select({ householdId: customers.householdId, customerId: customers.id })
    .from(customers)
    .where(eq(customers.cognitoSub, cognitoSub))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`sandbox-fulfillment: no seeded customer for cognitoSub "${cognitoSub}".`);
  }
  return row;
}

async function waitForPaidAndConfirmed(orderId: OrderId): Promise<void> {
  const deadline = Date.now() + FULFILLMENT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const found = await getOrderWithLineItems(orderId);
    if (found !== null && found.order.status === 'PAID') {
      const reservationLineItem = found.lineItems.find((lineItem) => lineItem.reservationId !== null);
      if (reservationLineItem?.reservationId != null) {
        const reservation = await getReservationById(reservationLineItem.reservationId);
        if (reservation !== null && reservation.status === 'CONFIRMED') {
          return;
        }
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(
    `sandbox-fulfillment: order "${orderId}" did not reach PAID with a CONFIRMED reservation within ` +
      `${FULFILLMENT_TIMEOUT_MS}ms. Check the deployed square-webhook Lambda's logs.`,
  );
}

test.describe('sandbox payment-to-fulfillment (SC-20)', () => {
  test.skip(
    !hasSquareCredentials,
    'SQUARE_ACCESS_TOKEN is not set — skipped. This test uses the real Square client and a deployed ' +
      'webhook endpoint; run it manually before a release. See docs/testing.md "Deployed-stage tests".',
  );

  test('a completed sandbox payment fulfills its order end to end', async () => {
    const notificationUrl = requireEnv('SQUARE_NOTIFICATION_URL');
    const signingKey = requireEnv('SQUARE_WEBHOOK_SIGNATURE_KEY');

    const { householdId, customerId } = await householdAndCustomerId(TEST_USERS.CUSTOMER.cognitoSub);

    // A class line, not a cafe item: SC-20 must prove the reservation
    // reaches CONFIRMED, not merely that the order reaches PAID.
    const cart: Cart = {
      lines: [
        {
          kind: 'OCCURRENCE',
          occurrenceId: createOccurrenceId(E2E_OCCURRENCE_ID),
          participants: [{ kind: 'CHILD', childId: createChildId(E2E_CHILD.id) }],
        },
      ],
    };

    const { order } = await createOrder({
      cart,
      householdId: createHouseholdId(householdId),
      createdByCustomerId: createCustomerId(customerId),
      seatHolder: createSeatHolder(),
    });

    // The real client — unlike every other test in this program, which uses
    // createStubSquareClient (see fixtures/square-stub.ts). Reads
    // SQUARE_ACCESS_TOKEN / SQUARE_ENVIRONMENT from the environment.
    const squareClient = createSquareClient();
    const { squareOrderId } = await startCheckout({
      squareClient,
      orderId: order.id,
      redirectUrl: `${APP_BASE_URL}/orders/${order.id}`,
    });

    // Completes the sandbox payment directly against Square's Payments API
    // using its documented sandbox test card nonce (`cnon:card-nonce-ok`),
    // rather than automating Square's own hosted checkout UI — Square
    // documents this nonce specifically for automated sandbox testing, and
    // it exercises the same payment-capture path a real card would.
    const rawSdk = new SquareSdkClient({
      token: requireEnv('SQUARE_ACCESS_TOKEN'),
      environment:
        process.env['SQUARE_ENVIRONMENT'] === 'production' ? SquareEnvironment.Production : SquareEnvironment.Sandbox,
    });
    const paymentResponse = await rawSdk.payments.create({
      sourceId: 'cnon:card-nonce-ok',
      idempotencyKey: randomUUID(),
      amountMoney: { amount: BigInt(order.subtotalCents), currency: order.currency as Currency },
      orderId: squareOrderId,
    });
    const payment = paymentResponse.payment;
    if (payment?.id === undefined || payment.status === undefined || payment.amountMoney?.amount === undefined) {
      throw new Error('sandbox-fulfillment: Square did not return a usable payment.');
    }

    // The real Square webhook wire shape (snake_case), matching what
    // functions/square-webhook/src/consumer.ts parses — see
    // consumer.test.ts's paymentWebhookRawBody fixture for the same shape.
    const rawBody = JSON.stringify({
      merchant_id: 'sandbox-fulfillment-e2e',
      type: 'payment.updated',
      event_id: randomUUID(),
      created_at: new Date().toISOString(),
      data: {
        type: 'payment',
        id: payment.id,
        object: {
          id: payment.id,
          status: payment.status,
          amount_money: { amount: Number(payment.amountMoney.amount), currency: payment.amountMoney.currency },
          order_id: squareOrderId,
        },
      },
    });
    const signature = signWebhookBody({ rawBody, notificationUrl, signingKey });

    const response = await fetch(notificationUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-square-signature': signature },
      body: rawBody,
    });
    if (response.status !== 200) {
      throw new Error(
        `sandbox-fulfillment: POST to the deployed webhook endpoint "${notificationUrl}" returned ` +
          `${response.status}, expected 200.`,
      );
    }

    // The webhook is delivered asynchronously (HTTP ingress enqueues to
    // SQS; a separate consumer Lambda drains it), so fulfillment is not
    // guaranteed to have landed by the time the POST above returns.
    await waitForPaidAndConfirmed(order.id);
  });
});
