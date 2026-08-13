import { describe, expect, it } from 'vitest';

const hasLiveDatabase =
  Boolean(process.env['DATABASE_URL_POOLED']) && Boolean(process.env['DATABASE_URL_DIRECT']);

// transitionOrder's single-conditional-UPDATE guarantee only means something
// against a real Postgres row, not a mocked query builder. Skipped when Neon
// credentials are unset (e.g. locally) and runs in CI once the branch is
// provisioned. Uses dynamic imports so a skipped run never triggers
// @keki/database's eager env validation at import time (see
// packages/notification-core/src/outbox.test.ts for the same pattern).
describe.skipIf(!hasLiveDatabase)('integration: transitionOrder', () => {
  async function seedHouseholdAndCustomer() {
    const { db, households, customers } = await import('@keki/database');
    const [household] = await db
      .insert(households)
      .values({ name: `WS-05 Order-State Household ${crypto.randomUUID()}` })
      .returning();
    const [customer] = await db
      .insert(customers)
      .values({
        householdId: household!.id,
        cognitoSub: `cognito-${crypto.randomUUID()}`,
        firstName: 'Test',
        lastName: 'Customer',
      })
      .returning();
    return { household: household!, customer: customer! };
  }

  async function seedOrder(status: 'DRAFT' | 'AWAITING_PAYMENT' | 'PAID' = 'DRAFT') {
    const { db, orders } = await import('@keki/database');
    const { household, customer } = await seedHouseholdAndCustomer();
    const [order] = await db
      .insert(orders)
      .values({
        householdId: household.id,
        createdByCustomerId: customer.id,
        status,
        subtotalCents: 1000,
        currency: 'USD',
      })
      .returning();
    return order!;
  }

  it('permits a legal edge: DRAFT -> AWAITING_PAYMENT (test 21)', async () => {
    const { transitionOrder } = await import('./order-state');
    const { createOrderId } = await import('@keki/contracts');

    const order = await seedOrder('DRAFT');

    const result = await transitionOrder({ orderId: createOrderId(order.id), to: 'AWAITING_PAYMENT' });

    expect(result.changed).toBe(true);
    expect(result.order.status).toBe('AWAITING_PAYMENT');
  });

  it('rejects an illegal edge: DRAFT -> PAID throws (test 22)', async () => {
    const { transitionOrder } = await import('./order-state');
    const { InvalidOrderTransitionError } = await import('./errors');
    const { createOrderId } = await import('@keki/contracts');

    const order = await seedOrder('DRAFT');

    await expect(
      transitionOrder({ orderId: createOrderId(order.id), to: 'PAID' }),
    ).rejects.toBeInstanceOf(InvalidOrderTransitionError);
  });

  it('is idempotent on a repeat: changed is false without throwing (test 23)', async () => {
    const { transitionOrder } = await import('./order-state');
    const { createOrderId } = await import('@keki/contracts');

    const order = await seedOrder('DRAFT');
    const orderId = createOrderId(order.id);

    await transitionOrder({ orderId, to: 'AWAITING_PAYMENT' });
    const second = await transitionOrder({ orderId, to: 'AWAITING_PAYMENT' });

    expect(second.changed).toBe(false);
    expect(second.order.status).toBe('AWAITING_PAYMENT');
  });

  it('detects a concurrent change: a mismatched expect fails rather than overwriting (test 24)', async () => {
    const { transitionOrder } = await import('./order-state');
    const { getOrderById } = await import('./queries');
    const { InvalidOrderTransitionError } = await import('./errors');
    const { createOrderId } = await import('@keki/contracts');

    const order = await seedOrder('DRAFT');
    const orderId = createOrderId(order.id);

    // A concurrent actor (e.g. startCheckout) already moved this order to
    // AWAITING_PAYMENT by the time this call's stale `expect: 'DRAFT'` runs.
    await transitionOrder({ orderId, to: 'AWAITING_PAYMENT' });

    await expect(
      transitionOrder({ orderId, to: 'CANCELLED', expect: 'DRAFT' }),
    ).rejects.toBeInstanceOf(InvalidOrderTransitionError);

    const current = await getOrderById(orderId);
    expect(current?.status).toBe('AWAITING_PAYMENT');
  });

  it('treats PAID as terminal: PAID -> CANCELLED throws (test 25)', async () => {
    const { transitionOrder } = await import('./order-state');
    const { InvalidOrderTransitionError } = await import('./errors');
    const { createOrderId } = await import('@keki/contracts');

    const order = await seedOrder('PAID');

    await expect(
      transitionOrder({ orderId: createOrderId(order.id), to: 'CANCELLED' }),
    ).rejects.toBeInstanceOf(InvalidOrderTransitionError);
  });

  it('rejects a transition for a non-existent order', async () => {
    const { transitionOrder } = await import('./order-state');
    const { OrderNotFoundError } = await import('./errors');
    const { createOrderId } = await import('@keki/contracts');

    await expect(
      transitionOrder({ orderId: createOrderId(crypto.randomUUID()), to: 'AWAITING_PAYMENT' }),
    ).rejects.toBeInstanceOf(OrderNotFoundError);
  });

  it('applies the patch fields atomically with the status change', async () => {
    const { transitionOrder } = await import('./order-state');
    const { createOrderId } = await import('@keki/contracts');

    const order = await seedOrder('DRAFT');

    const result = await transitionOrder({
      orderId: createOrderId(order.id),
      to: 'AWAITING_PAYMENT',
      patch: { squareOrderId: 'square-order-1', squareCheckoutUrl: 'https://square.example/checkout/1' },
    });

    expect(result.order.squareOrderId).toBe('square-order-1');
    expect(result.order.squareCheckoutUrl).toBe('https://square.example/checkout/1');
  });
});
