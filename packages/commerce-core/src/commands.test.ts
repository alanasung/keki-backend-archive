import { describe, expect, it, vi } from 'vitest';
import { createReservationId } from '@keki/contracts';
import type { SquareClient } from '@keki/contracts';
import { capturePayment, refundPayment, startCheckout } from './commands';

const reservationId = createReservationId('11111111-1111-4111-8111-111111111111');

const squareClient: SquareClient = {
  createCheckout: vi.fn(),
  getPayment: vi.fn(),
  refundPayment: vi.fn(),
  verifyWebhookSignature: vi.fn(),
};

describe('deferred commerce commands', () => {
  const cases: Array<[string, () => Promise<unknown>]> = [
    [
      'startCheckout',
      () =>
        startCheckout({
          squareClient,
          reservationId,
          amountCents: 1000,
          currency: 'USD',
        }),
    ],
    [
      'capturePayment',
      () => capturePayment({ squareClient, providerPaymentId: 'square-payment-1' }),
    ],
    [
      'refundPayment',
      () => refundPayment({ squareClient, providerPaymentId: 'square-payment-1', amountCents: 500 }),
    ],
  ];

  it.each(cases)('%s throws NotImplementedInPhase1', async (_name, run) => {
    await expect(run()).rejects.toMatchObject({ kind: 'NotImplementedInPhase1' });
  });
});
