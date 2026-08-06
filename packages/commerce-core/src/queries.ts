import { eq } from 'drizzle-orm';
import { db, paymentRecords } from '@keki/database';
import {
  createPaymentRecordId,
  createReservationId,
  type HouseholdId,
  type PaymentRecord,
} from '@keki/contracts';

interface PaymentRecordRow {
  id: string;
  reservationId: string | null;
  status: PaymentRecord['status'];
  amountCents: number;
  currency: string;
  providerPaymentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// `payment_records.provider_payment_id` has no NOT NULL constraint at the
// schema level (see packages/database/src/schema/commerce.ts), but every row
// this package writes (via recordPaymentFromWebhook) always sets one.
export function toPaymentRecord(row: PaymentRecordRow): PaymentRecord {
  return {
    id: createPaymentRecordId(row.id),
    reservationId: row.reservationId === null ? null : createReservationId(row.reservationId),
    status: row.status,
    amountCents: row.amountCents,
    currency: row.currency,
    providerPaymentId: row.providerPaymentId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getPaymentByProviderId(providerPaymentId: string): Promise<PaymentRecord | null> {
  const rows = await db
    .select()
    .from(paymentRecords)
    .where(eq(paymentRecords.providerPaymentId, providerPaymentId))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toPaymentRecord(row);
}

export async function listPaymentsForHousehold(
  householdId: HouseholdId,
): Promise<readonly PaymentRecord[]> {
  const rows = await db.select().from(paymentRecords).where(eq(paymentRecords.householdId, householdId));
  return rows.map(toPaymentRecord);
}
