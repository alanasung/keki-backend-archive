import { randomUUID } from 'node:crypto';
import { SquareError } from 'square';
import type { SquareClient as SquareSdkClient } from 'square';
import { createPaymentRecordId } from '@keki/contracts';
import type { PaymentRecord, PaymentStatus } from '@keki/contracts';

// Square's `Payment.status` is typed as a bare `string` in the SDK, but
// Square documents exactly five values: APPROVED, PENDING, COMPLETED,
// CANCELED, FAILED. This is a total function over those five — the
// `default` throws rather than coercing an unrecognized value to FAILED,
// because a new Square status must surface as an error, not silently
// become a wrong payment state.
export function mapSquarePaymentStatus(status: string | undefined): PaymentStatus {
  switch (status) {
    case 'PENDING':
      return 'PENDING';
    case 'APPROVED':
      return 'AUTHORIZED';
    case 'COMPLETED':
      return 'CAPTURED';
    case 'CANCELED':
      return 'FAILED';
    case 'FAILED':
      return 'FAILED';
    default:
      throw new Error(`mapSquarePaymentStatus: unrecognized Square payment status "${String(status)}".`);
  }
}

export async function getPayment(
  sdk: SquareSdkClient,
  input: { providerPaymentId: string },
): Promise<PaymentRecord | null> {
  let payment;
  try {
    const response = await sdk.payments.get({ paymentId: input.providerPaymentId });
    payment = response.payment;
  } catch (error) {
    if (error instanceof SquareError && error.statusCode === 404) {
      return null;
    }
    throw error;
  }

  if (payment === undefined) {
    return null;
  }

  const amount = payment.amountMoney?.amount;
  const currency = payment.amountMoney?.currency;
  if (amount === undefined || amount === null || currency === undefined) {
    throw new Error(`getPayment: Square payment "${input.providerPaymentId}" is missing amount_money.`);
  }

  const now = new Date();

  // Square carries no database identity for a payment, so `id` here is a
  // fresh surrogate, not a persisted primary key. The real identity
  // downstream code keys on is `providerPaymentId` (unique in
  // payment_records — see docs/as-built.md's data model).
  return {
    id: createPaymentRecordId(randomUUID()),
    reservationId: null,
    status: mapSquarePaymentStatus(payment.status),
    amountCents: Number(amount),
    currency,
    providerPaymentId: payment.id ?? input.providerPaymentId,
    createdAt: payment.createdAt !== undefined ? new Date(payment.createdAt) : now,
    updatedAt: payment.updatedAt !== undefined ? new Date(payment.updatedAt) : now,
  };
}

export async function refundPayment(
  sdk: SquareSdkClient,
  input: { providerPaymentId: string; amountCents: number; idempotencyKey: string },
): Promise<{ refundId: string }> {
  // Square's refund request requires a currency on `amountMoney`, but the
  // SquareClient interface's refundPayment input does not carry one — look
  // it up from the original payment rather than assuming a currency.
  const paymentResponse = await sdk.payments.get({ paymentId: input.providerPaymentId });
  const currency = paymentResponse.payment?.amountMoney?.currency;
  if (currency === undefined) {
    throw new Error(
      `refundPayment: could not determine the currency of payment "${input.providerPaymentId}".`,
    );
  }

  const response = await sdk.refunds.refundPayment({
    idempotencyKey: input.idempotencyKey,
    paymentId: input.providerPaymentId,
    amountMoney: { amount: BigInt(input.amountCents), currency },
  });

  if (response.refund?.id === undefined) {
    throw new Error('refundPayment: Square did not return a refund id.');
  }

  return { refundId: response.refund.id };
}
