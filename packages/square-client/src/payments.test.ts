import { describe, expect, it, vi } from 'vitest';
import type { SquareClient as SquareSdkClient } from 'square';
import { SquareError } from 'square';
import { getPayment, mapSquarePaymentStatus, refundPayment } from './payments';

function fakeSdk(overrides: {
  get?: () => unknown;
  refundPayment?: () => unknown;
}) {
  const getMock = vi.fn(overrides.get ?? (() => Promise.resolve({ payment: undefined })));
  const refundMock = vi.fn(
    overrides.refundPayment ?? (() => Promise.resolve({ refund: { id: 'refund-1' } })),
  );
  const sdk = {
    payments: { get: getMock },
    refunds: { refundPayment: refundMock },
  } as unknown as SquareSdkClient;
  return { sdk, getMock, refundMock };
}

describe('mapSquarePaymentStatus', () => {
  it.each([
    ['PENDING', 'PENDING'],
    ['APPROVED', 'AUTHORIZED'],
    ['COMPLETED', 'CAPTURED'],
    ['CANCELED', 'FAILED'],
    ['FAILED', 'FAILED'],
  ] as const)('maps documented Square status %s to %s', (squareStatus, expected) => {
    expect(mapSquarePaymentStatus(squareStatus)).toBe(expected);
  });

  it('throws on an unrecognized status rather than coercing to FAILED', () => {
    expect(() => mapSquarePaymentStatus('SOME_NEW_STATUS')).toThrow(/SOME_NEW_STATUS/);
  });
});

describe('getPayment', () => {
  it('maps a Square payment to our shape', async () => {
    const { sdk } = fakeSdk({
      get: () =>
        Promise.resolve({
          payment: {
            id: 'sq-payment-1',
            status: 'COMPLETED',
            amountMoney: { amount: 1000n, currency: 'USD' },
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:05:00.000Z',
          },
        }),
    });

    const result = await getPayment(sdk, { providerPaymentId: 'sq-payment-1' });

    expect(result).toMatchObject({
      status: 'CAPTURED',
      amountCents: 1000,
      currency: 'USD',
      providerPaymentId: 'sq-payment-1',
      reservationId: null,
    });
  });

  it('throws when a documented status is unrecognized locally', async () => {
    const { sdk } = fakeSdk({
      get: () =>
        Promise.resolve({
          payment: {
            id: 'sq-payment-1',
            status: 'SOME_NEW_STATUS',
            amountMoney: { amount: 1000n, currency: 'USD' },
          },
        }),
    });

    await expect(getPayment(sdk, { providerPaymentId: 'sq-payment-1' })).rejects.toThrow();
  });

  it('returns null when Square responds 404', async () => {
    const { sdk } = fakeSdk({
      get: () => {
        throw new SquareError({ statusCode: 404, message: 'not found' });
      },
    });

    await expect(getPayment(sdk, { providerPaymentId: 'missing' })).resolves.toBeNull();
  });
});

describe('refundPayment', () => {
  it('returns the refund id Square assigns', async () => {
    const { sdk, refundMock } = fakeSdk({
      get: () => Promise.resolve({ payment: { amountMoney: { currency: 'USD' } } }),
      refundPayment: () => Promise.resolve({ refund: { id: 'refund-99' } }),
    });

    const result = await refundPayment(sdk, {
      providerPaymentId: 'sq-payment-1',
      amountCents: 500,
      idempotencyKey: 'idem-1',
    });

    expect(result).toEqual({ refundId: 'refund-99' });
    expect(refundMock).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'idem-1',
        paymentId: 'sq-payment-1',
        amountMoney: { amount: 500n, currency: 'USD' },
      }),
    );
  });
});
