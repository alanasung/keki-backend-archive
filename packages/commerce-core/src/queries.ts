import { desc, eq } from 'drizzle-orm';
import { db, orderLineItems, orders, paymentRecords } from '@keki/database';
import {
  createCatalogItemId,
  createCustomerId,
  createHouseholdId,
  createOccurrenceId,
  createOrderId,
  createOrderLineItemId,
  createPaymentRecordId,
  createReservationId,
  type HouseholdId,
  type Order,
  type OrderId,
  type OrderLineItem,
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

interface OrderRow {
  id: string;
  householdId: string;
  createdByCustomerId: string;
  status: Order['status'];
  subtotalCents: number;
  currency: string;
  squareOrderId: string | null;
  squareCheckoutUrl: string | null;
  providerPaymentId: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export function toOrder(row: OrderRow): Order {
  return {
    id: createOrderId(row.id),
    householdId: createHouseholdId(row.householdId),
    createdByCustomerId: createCustomerId(row.createdByCustomerId),
    status: row.status,
    subtotalCents: row.subtotalCents,
    currency: row.currency,
    squareOrderId: row.squareOrderId,
    squareCheckoutUrl: row.squareCheckoutUrl,
    providerPaymentId: row.providerPaymentId,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

interface OrderLineItemRow {
  id: string;
  orderId: string;
  kind: OrderLineItem['kind'];
  catalogItemId: string | null;
  occurrenceId: string | null;
  reservationId: string | null;
  quantity: number;
  unitPriceCents: number;
  nameSnapshot: string;
}

export function toOrderLineItem(row: OrderLineItemRow): OrderLineItem {
  return {
    id: createOrderLineItemId(row.id),
    orderId: createOrderId(row.orderId),
    kind: row.kind,
    catalogItemId: row.catalogItemId === null ? null : createCatalogItemId(row.catalogItemId),
    occurrenceId: row.occurrenceId === null ? null : createOccurrenceId(row.occurrenceId),
    reservationId: row.reservationId === null ? null : createReservationId(row.reservationId),
    quantity: row.quantity,
    unitPriceCents: row.unitPriceCents,
    nameSnapshot: row.nameSnapshot,
  };
}

export async function getOrderById(orderId: OrderId): Promise<Order | null> {
  const rows = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  const row = rows[0];
  return row === undefined ? null : toOrder(row);
}

export async function getOrderWithLineItems(
  orderId: OrderId,
): Promise<{ order: Order; lineItems: readonly OrderLineItem[] } | null> {
  const order = await getOrderById(orderId);
  if (order === null) {
    return null;
  }
  const lineItemRows = await db.select().from(orderLineItems).where(eq(orderLineItems.orderId, orderId));
  return { order, lineItems: lineItemRows.map(toOrderLineItem) };
}

// WS-10 resolves an order from the reference Square echoes back on the
// payment webhook, so this is keyed on squareOrderId rather than our own id.
export async function getOrderBySquareOrderId(squareOrderId: string): Promise<Order | null> {
  const rows = await db.select().from(orders).where(eq(orders.squareOrderId, squareOrderId)).limit(1);
  const row = rows[0];
  return row === undefined ? null : toOrder(row);
}

export async function listOrdersForHousehold(householdId: HouseholdId): Promise<readonly Order[]> {
  const rows = await db
    .select()
    .from(orders)
    .where(eq(orders.householdId, householdId))
    .orderBy(desc(orders.createdAt));
  return rows.map(toOrder);
}
