import { eq } from 'drizzle-orm';
import { db, paymentRecords } from '@keki/database';
import type { HouseholdId, PaymentRecord, PaymentStatus, ReservationId } from '@keki/contracts';
import { toPaymentRecord } from './queries';

// Square redelivers webhooks, so landing a payment must be idempotent on
// `provider_payment_id` (its unique constraint — see
// packages/database/src/schema/commerce.ts). Insert speculatively and
// no-op on conflict, then read back the existing row, rather than a racy
// check-then-insert — the same shape as customer-core's
// provisionCustomerProfile.
export async function recordPaymentFromWebhook(input: {
  providerPaymentId: string;
  householdId: HouseholdId;
  reservationId?: ReservationId;
  amountCents: number;
  currency: string;
  status: PaymentStatus;
  rawPayload: Record<string, unknown>;
  occurredAt: Date;
}): Promise<{ record: PaymentRecord; created: boolean }> {
  const inserted = await db
    .insert(paymentRecords)
    .values({
      householdId: input.householdId,
      ...(input.reservationId !== undefined ? { reservationId: input.reservationId } : {}),
      providerPaymentId: input.providerPaymentId,
      amountCents: input.amountCents,
      currency: input.currency,
      status: input.status,
      rawPayload: input.rawPayload,
      occurredAt: input.occurredAt,
    })
    .onConflictDoNothing({ target: paymentRecords.providerPaymentId })
    .returning();

  const insertedRow = inserted[0];
  if (insertedRow !== undefined) {
    return { record: toPaymentRecord(insertedRow), created: true };
  }

  const existingRows = await db
    .select()
    .from(paymentRecords)
    .where(eq(paymentRecords.providerPaymentId, input.providerPaymentId))
    .limit(1);
  const existingRow = existingRows[0];
  if (existingRow === undefined) {
    throw new Error(
      `recordPaymentFromWebhook: insert conflicted on providerPaymentId "${input.providerPaymentId}" but no existing row was found.`,
    );
  }
  return { record: toPaymentRecord(existingRow), created: false };
}
