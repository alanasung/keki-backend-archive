import { describe, expect, it, vi } from 'vitest';
import type { SquareCheckoutLineItem } from '@keki/contracts';

const hasLiveDatabase =
  Boolean(process.env['DATABASE_URL_POOLED']) && Boolean(process.env['DATABASE_URL_DIRECT']);

// startCheckout reads and writes real `orders`/`order_line_items` rows
// (through queries.ts and order-state.ts, both of which import
// @keki/database), so this whole file needs a live Postgres connection even
// for capturePayment/refundPayment, which never touch a row — importing
// `./commands` at all triggers @keki/database's eager env validation.
// Skipped when Neon credentials are unset (e.g. locally) and runs in CI once
// the branch is provisioned. Uses dynamic imports so a skipped run never
// triggers that validation at import time (see
// packages/notification-core/src/outbox.test.ts for the same pattern).
describe.skipIf(!hasLiveDatabase)('commerce-core commands', () => {
  async function seedHouseholdAndCustomer() {
    const { db, households, customers } = await import('@keki/database');
    const [household] = await db
      .insert(households)
      .values({ name: `WS-05 Commands Household ${crypto.randomUUID()}` })
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

  async function seedCatalogItem(priceCents = 500) {
    const { db, catalogItems } = await import('@keki/database');
    const [item] = await db
      .insert(catalogItems)
      .values({
        squareCatalogObjectId: `object-${crypto.randomUUID()}`,
        squareVariationId: `var-${crypto.randomUUID()}`,
        name: 'Test Cafe Item',
        priceCents,
        status: 'ACTIVE',
      })
      .returning();
    return item!;
  }

  async function seedOrder(status: 'DRAFT' | 'PAID' = 'DRAFT') {
    const { createOrder } = await import('./orders');
    const { createCatalogItemId, createCustomerId, createHouseholdId } = await import('@keki/contracts');

    const { household, customer } = await seedHouseholdAndCustomer();
    const item = await seedCatalogItem(500);

    const { order } = await createOrder({
      cart: { lines: [{ kind: 'CATALOG_ITEM', catalogItemId: createCatalogItemId(item.id), quantity: 2 }] },
      householdId: createHouseholdId(household.id),
      createdByCustomerId: createCustomerId(customer.id),
      seatHolder: { holdSeats: vi.fn() },
    });

    if (status === 'PAID') {
      const { transitionOrder } = await import('./order-state');
      await transitionOrder({
        orderId: order.id,
        to: 'AWAITING_PAYMENT',
        patch: { squareOrderId: `square-${crypto.randomUUID()}`, squareCheckoutUrl: 'https://square.example/x' },
      });
      const paid = await transitionOrder({ orderId: order.id, to: 'PAID' });
      return paid.order;
    }
    return order;
  }

  // Deliberately not annotated as `SquareClient`: that interface declares
  // `createCheckout` etc. with method shorthand, and widening these spies to
  // that type would make `expect(squareClient.createCheckout)` below trip
  // `@typescript-eslint/unbound-method` (it can't tell a bound `vi.fn()` from
  // an unbound method reference) — see
  // packages/notification-core/src/dispatch.test.ts's makeSpyProviders for
  // the same reasoning. Structural typing still makes this object assignable
  // wherever `SquareClient` is expected.
  function stubSquareClient(overrides: { createCheckout?: ReturnType<typeof vi.fn> } = {}) {
    // Unique per stub instance because `orders.square_order_id` is UNIQUE and
    // these live-database suites share one Neon branch that is never truncated
    // -- not between test files in a run, and not between CI runs. A fixed
    // literal here collided with order-state.test.ts's own fixture.
    const squareOrderId = `square-order-${crypto.randomUUID()}`;
    return {
      listCatalogItems: vi.fn(),
      createCheckout:
        overrides.createCheckout ??
        vi.fn(() =>
          Promise.resolve({
            checkoutUrl: 'https://square.example/checkout/1',
            squareOrderId,
          }),
        ),
      getPayment: vi.fn(),
      refundPayment: vi.fn(),
      verifyWebhookSignature: vi.fn(),
    };
  }

  describe('startCheckout', () => {
    it('calls Square once and stores the checkout URL (test 26)', async () => {
      const { startCheckout } = await import('./commands');
      const { getOrderById } = await import('./queries');

      const order = await seedOrder();
      const squareClient = stubSquareClient();

      const result = await startCheckout({
        squareClient,
        orderId: order.id,
        redirectUrl: 'https://example.com/return',
      });

      expect(squareClient.createCheckout).toHaveBeenCalledTimes(1);
      expect(result.checkoutUrl).toBe('https://square.example/checkout/1');

      const persisted = await getOrderById(order.id);
      expect(persisted?.status).toBe('AWAITING_PAYMENT');
      expect(persisted?.squareCheckoutUrl).toBe('https://square.example/checkout/1');
    });

    it('is idempotent: a second call reaches Square once and returns the same URL (test 27)', async () => {
      const { startCheckout } = await import('./commands');

      const order = await seedOrder();
      const squareClient = stubSquareClient();
      const input = { squareClient, orderId: order.id, redirectUrl: 'https://example.com/return' };

      const first = await startCheckout(input);
      const second = await startCheckout(input);

      expect(squareClient.createCheckout).toHaveBeenCalledTimes(1);
      expect(second.checkoutUrl).toBe(first.checkoutUrl);
      expect(second.squareOrderId).toBe(first.squareOrderId);
    });

    it('builds Square line items from the persisted order rows, not caller input (test 28)', async () => {
      const { startCheckout } = await import('./commands');
      const { getOrderWithLineItems } = await import('./queries');

      const order = await seedOrder();
      const squareClient = stubSquareClient();

      await startCheckout({ squareClient, orderId: order.id, redirectUrl: 'https://example.com/return' });

      const persisted = await getOrderWithLineItems(order.id);
      const expectedLineItems: SquareCheckoutLineItem[] = (persisted?.lineItems ?? []).map((item) => ({
        name: item.nameSnapshot,
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
      }));

      expect(squareClient.createCheckout).toHaveBeenCalledWith(
        expect.objectContaining({ lineItems: expectedLineItems }),
      );
    });

    it('passes the order id as the idempotency key (test 29)', async () => {
      const { startCheckout } = await import('./commands');

      const order = await seedOrder();
      const squareClient = stubSquareClient();

      await startCheckout({ squareClient, orderId: order.id, redirectUrl: 'https://example.com/return' });

      expect(squareClient.createCheckout).toHaveBeenCalledWith(
        expect.objectContaining({ idempotencyKey: order.id }),
      );
    });

    it('leaves the order retryable on a Square outage (test 30)', async () => {
      const { startCheckout } = await import('./commands');
      const { getOrderById } = await import('./queries');

      const order = await seedOrder();
      const squareClient = stubSquareClient({
        createCheckout: vi.fn(() => Promise.reject(new Error('Square is unreachable'))),
      });

      await expect(
        startCheckout({ squareClient, orderId: order.id, redirectUrl: 'https://example.com/return' }),
      ).rejects.toThrow('Square is unreachable');

      const persisted = await getOrderById(order.id);
      expect(persisted?.status).toBe('DRAFT');
      expect(persisted?.squareCheckoutUrl).toBeNull();
    });

    it('rejects a paid order (test 31)', async () => {
      const { startCheckout } = await import('./commands');
      const { InvalidOrderTransitionError } = await import('./errors');

      const order = await seedOrder('PAID');
      const squareClient = stubSquareClient();

      await expect(
        startCheckout({ squareClient, orderId: order.id, redirectUrl: 'https://example.com/return' }),
      ).rejects.toBeInstanceOf(InvalidOrderTransitionError);
      expect(squareClient.createCheckout).not.toHaveBeenCalled();
    });
  });

  describe('deferred commerce commands (test 32)', () => {
    it('capturePayment throws NotImplementedInPhase1', async () => {
      const { capturePayment } = await import('./commands');

      await expect(
        capturePayment({ squareClient: stubSquareClient(), providerPaymentId: 'square-payment-1' }),
      ).rejects.toMatchObject({ kind: 'NotImplementedInPhase1' });
    });

    it('refundPayment throws NotImplementedInPhase1', async () => {
      const { refundPayment } = await import('./commands');

      await expect(
        refundPayment({ squareClient: stubSquareClient(), providerPaymentId: 'square-payment-1', amountCents: 500 }),
      ).rejects.toMatchObject({ kind: 'NotImplementedInPhase1' });
    });
  });
});
