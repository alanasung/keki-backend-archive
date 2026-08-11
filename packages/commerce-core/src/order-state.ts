import { and, eq, inArray } from 'drizzle-orm';
import { db, orders } from '@keki/database';
import {
  canTransition,
  ORDER_STATUSES,
  type Order,
  type OrderId,
  type OrderStatus,
} from '@keki/contracts';
import { InvalidOrderTransitionError, OrderNotFoundError } from './errors';
import { getOrderById, toOrder } from './queries';

// Does the read and write as a single conditional
// `UPDATE ... WHERE id = $1 AND status IN (...)`, never read-then-write. A
// read-then-write would race the payment webhook — a customer could pay
// while an expiry sweep cancels the same order.
export async function transitionOrder(input: {
  orderId: OrderId;
  to: OrderStatus;
  expect?: OrderStatus;
  patch?: Partial<Pick<Order, 'squareOrderId' | 'squareCheckoutUrl' | 'providerPaymentId'>>;
  now?: Date;
}): Promise<{ order: Order; changed: boolean }> {
  const now = input.now ?? new Date();

  if (input.expect !== undefined && !canTransition(input.expect, input.to)) {
    throw new InvalidOrderTransitionError(input.orderId, input.expect, input.to);
  }

  // With no `expect`, any status that legally transitions to `to` is
  // acceptable — `to: 'CANCELLED'` is reachable from both DRAFT and
  // AWAITING_PAYMENT, so the guard is an IN-list, not a single equality.
  const validFromStatuses: readonly OrderStatus[] =
    input.expect !== undefined
      ? [input.expect]
      : ORDER_STATUSES.filter((status) => canTransition(status, input.to));

  const updatedRows =
    validFromStatuses.length === 0
      ? []
      : await db
          .update(orders)
          .set({ status: input.to, updatedAt: now, ...(input.patch ?? {}) })
          .where(and(eq(orders.id, input.orderId), inArray(orders.status, validFromStatuses)))
          .returning();

  const updatedRow = updatedRows[0];
  if (updatedRow !== undefined) {
    return { order: toOrder(updatedRow), changed: true };
  }

  // Nothing matched the guarded UPDATE — this diagnostic read decides
  // between a not-found order, an idempotent repeat (WS-10's webhook is
  // SQS-retried and must re-run harmlessly), and a genuinely illegal edge.
  // It never feeds back into what gets written.
  const existing = await getOrderById(input.orderId);
  if (existing === null) {
    throw new OrderNotFoundError(input.orderId);
  }
  if (input.expect !== undefined && existing.status !== input.expect) {
    throw new InvalidOrderTransitionError(input.orderId, existing.status, input.to);
  }
  if (existing.status === input.to) {
    return { order: existing, changed: false };
  }
  throw new InvalidOrderTransitionError(input.orderId, existing.status, input.to);
}
