import { describe, expect, it, vi } from 'vitest';
import type { Cart, CartParticipantRef, SeatHolder } from '@keki/contracts';
import type { Tx } from '@keki/database';

const hasLiveDatabase =
  Boolean(process.env['DATABASE_URL_POOLED']) && Boolean(process.env['DATABASE_URL_DIRECT']);

// createOrder's whole point — server-computed pricing (SC-04), household
// participant validation (SC-18), and atomic order+seat creation (SC-19) —
// only means something against a real Postgres transaction and the real
// capacity trigger (drizzle/0002_capacity_constraint.sql), not a mocked
// query builder. Skipped when Neon credentials are unset (e.g. locally) and
// runs in CI once the branch is provisioned. Uses dynamic imports so a
// skipped run never triggers @keki/database's eager env validation at
// import time (see packages/notification-core/src/outbox.test.ts for the
// same pattern).
describe.skipIf(!hasLiveDatabase)('integration: createOrder', () => {
  async function seedHouseholdAndCustomer() {
    const { db, households, customers } = await import('@keki/database');
    const [household] = await db
      .insert(households)
      .values({ name: `WS-05 Household ${crypto.randomUUID()}` })
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

  async function seedChild(householdId: string) {
    const { db, children } = await import('@keki/database');
    const [child] = await db
      .insert(children)
      .values({ householdId, firstName: 'Test', lastName: 'Child', dateOfBirth: '2018-01-01' })
      .returning();
    return child!;
  }

  async function seedCatalogItem(
    overrides: { priceCents?: number; currency?: string; status?: 'ACTIVE' | 'ARCHIVED' } = {},
  ) {
    const { db, catalogItems } = await import('@keki/database');
    const [item] = await db
      .insert(catalogItems)
      .values({
        squareCatalogObjectId: `object-${crypto.randomUUID()}`,
        squareVariationId: `var-${crypto.randomUUID()}`,
        name: 'Test Cafe Item',
        priceCents: overrides.priceCents ?? 500,
        currency: overrides.currency ?? 'USD',
        status: overrides.status ?? 'ACTIVE',
      })
      .returning();
    return item!;
  }

  async function seedOffering(
    overrides: {
      priceCents?: number;
      currency?: string;
      status?: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
      defaultCapacity?: number;
    } = {},
  ) {
    const { db, offerings } = await import('@keki/database');
    const [offering] = await db
      .insert(offerings)
      .values({
        slug: `offering-${crypto.randomUUID()}`,
        name: 'Test Class',
        type: 'CLASS',
        durationMinutes: 60,
        defaultCapacity: overrides.defaultCapacity ?? 5,
        priceCents: overrides.priceCents ?? 2000,
        currency: overrides.currency ?? 'USD',
        status: overrides.status ?? 'PUBLISHED',
      })
      .returning();
    return offering!;
  }

  async function seedOccurrence(
    offeringId: string,
    overrides: { startsAt?: Date; status?: 'SCHEDULED' | 'CANCELLED' | 'COMPLETED' } = {},
  ) {
    const { db, occurrences } = await import('@keki/database');
    const startsAt = overrides.startsAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000);
    const [occurrence] = await db
      .insert(occurrences)
      .values({
        offeringId,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 60 * 60 * 1000),
        status: overrides.status ?? 'SCHEDULED',
      })
      .returning();
    return occurrence!;
  }

  // A stub that fails loudly if the flow under test reaches seat holding at
  // all — used by tests that must reject before ever calling the port.
  function unusedSeatHolder(): SeatHolder {
    return {
      holdSeats: vi.fn(() =>
        Promise.reject(new Error('seatHolder.holdSeats should not have been called')),
      ),
    };
  }

  async function realSeatHolder(): Promise<SeatHolder> {
    const { createSeatHolder } = await import('@keki/reservation-core');
    return createSeatHolder();
  }

  it('computes the subtotal from the database (test 1)', async () => {
    const { createOrder } = await import('./orders');
    const { createCatalogItemId, createCustomerId, createHouseholdId } = await import('@keki/contracts');

    const { household, customer } = await seedHouseholdAndCustomer();
    const item = await seedCatalogItem({ priceCents: 500 });

    const { order } = await createOrder({
      cart: { lines: [{ kind: 'CATALOG_ITEM', catalogItemId: createCatalogItemId(item.id), quantity: 2 }] },
      householdId: createHouseholdId(household.id),
      createdByCustomerId: createCustomerId(customer.id),
      seatHolder: unusedSeatHolder(),
    });

    expect(order.subtotalCents).toBe(1000);
  });

  it('ignores a tampered client-supplied price (test 2, SC-04)', async () => {
    const { createOrder } = await import('./orders');
    const { createCustomerId, createHouseholdId } = await import('@keki/contracts');
    const { db, orders } = await import('@keki/database');
    const { eq } = await import('drizzle-orm');

    const { household, customer } = await seedHouseholdAndCustomer();
    const item = await seedCatalogItem({ priceCents: 500 });
    const householdId = createHouseholdId(household.id);
    const holdSeats = vi.fn();

    const tamperedCart = {
      lines: [{ kind: 'CATALOG_ITEM', catalogItemId: item.id, quantity: 1, unitPriceCents: 1 }],
    } as unknown as Cart;

    await expect(
      createOrder({
        cart: tamperedCart,
        householdId,
        createdByCustomerId: createCustomerId(customer.id),
        seatHolder: { holdSeats },
      }),
    ).rejects.toThrow();

    expect(holdSeats).not.toHaveBeenCalled();
    const rows = await db.select().from(orders).where(eq(orders.householdId, householdId));
    expect(rows).toHaveLength(0);
  });

  it('snapshots the catalog price and name at order time (test 3)', async () => {
    const { createOrder } = await import('./orders');
    const { getOrderWithLineItems } = await import('./queries');
    const { createCatalogItemId, createCustomerId, createHouseholdId } = await import('@keki/contracts');
    const { catalogItems, db } = await import('@keki/database');
    const { eq } = await import('drizzle-orm');

    const { household, customer } = await seedHouseholdAndCustomer();
    const item = await seedCatalogItem({ priceCents: 500 });
    const catalogItemId = createCatalogItemId(item.id);

    const { order, lineItems } = await createOrder({
      cart: { lines: [{ kind: 'CATALOG_ITEM', catalogItemId, quantity: 1 }] },
      householdId: createHouseholdId(household.id),
      createdByCustomerId: createCustomerId(customer.id),
      seatHolder: unusedSeatHolder(),
    });

    expect(lineItems[0]?.unitPriceCents).toBe(500);
    expect(lineItems[0]?.nameSnapshot).toBe(item.name);

    await db.update(catalogItems).set({ priceCents: 999 }).where(eq(catalogItems.id, item.id));

    const refetched = await getOrderWithLineItems(order.id);
    expect(refetched?.lineItems[0]?.unitPriceCents).toBe(500);
  });

  it('derives occurrence quantity from participant count, not client input (test 4)', async () => {
    const { createOrder } = await import('./orders');
    const { createChildId, createCustomerId, createHouseholdId, createOccurrenceId } = await import(
      '@keki/contracts'
    );

    const { household, customer } = await seedHouseholdAndCustomer();
    const child = await seedChild(household.id);
    const offering = await seedOffering();
    const occurrence = await seedOccurrence(offering.id);
    const seatHolder = await realSeatHolder();

    const participants: readonly CartParticipantRef[] = [
      { kind: 'CUSTOMER', customerId: createCustomerId(customer.id) },
      { kind: 'CHILD', childId: createChildId(child.id) },
    ];

    const { lineItems } = await createOrder({
      cart: {
        lines: [{ kind: 'OCCURRENCE', occurrenceId: createOccurrenceId(occurrence.id), participants }],
      },
      householdId: createHouseholdId(household.id),
      createdByCustomerId: createCustomerId(customer.id),
      seatHolder,
    });

    expect(lineItems[0]?.quantity).toBe(2);
  });

  it('rejects a child from another household (test 5, SC-18)', async () => {
    const { createOrder } = await import('./orders');
    const { ParticipantNotInHouseholdError } = await import('./errors');
    const { createChildId, createCustomerId, createHouseholdId, createOccurrenceId } = await import(
      '@keki/contracts'
    );
    const { db, orders } = await import('@keki/database');
    const { eq } = await import('drizzle-orm');

    const { household, customer } = await seedHouseholdAndCustomer();
    const other = await seedHouseholdAndCustomer();
    const foreignChild = await seedChild(other.household.id);
    const offering = await seedOffering();
    const occurrence = await seedOccurrence(offering.id);
    const householdId = createHouseholdId(household.id);

    await expect(
      createOrder({
        cart: {
          lines: [
            {
              kind: 'OCCURRENCE',
              occurrenceId: createOccurrenceId(occurrence.id),
              participants: [{ kind: 'CHILD', childId: createChildId(foreignChild.id) }],
            },
          ],
        },
        householdId,
        createdByCustomerId: createCustomerId(customer.id),
        seatHolder: unusedSeatHolder(),
      }),
    ).rejects.toBeInstanceOf(ParticipantNotInHouseholdError);

    const rows = await db.select().from(orders).where(eq(orders.householdId, householdId));
    expect(rows).toHaveLength(0);
  });

  it('rejects a customer from another household (test 6, SC-18)', async () => {
    const { createOrder } = await import('./orders');
    const { ParticipantNotInHouseholdError } = await import('./errors');
    const { createCustomerId, createHouseholdId, createOccurrenceId } = await import('@keki/contracts');
    const { db, orders } = await import('@keki/database');
    const { eq } = await import('drizzle-orm');

    const { household, customer } = await seedHouseholdAndCustomer();
    const other = await seedHouseholdAndCustomer();
    const offering = await seedOffering();
    const occurrence = await seedOccurrence(offering.id);
    const householdId = createHouseholdId(household.id);

    await expect(
      createOrder({
        cart: {
          lines: [
            {
              kind: 'OCCURRENCE',
              occurrenceId: createOccurrenceId(occurrence.id),
              participants: [{ kind: 'CUSTOMER', customerId: createCustomerId(other.customer.id) }],
            },
          ],
        },
        householdId,
        createdByCustomerId: createCustomerId(customer.id),
        seatHolder: unusedSeatHolder(),
      }),
    ).rejects.toBeInstanceOf(ParticipantNotInHouseholdError);

    const rows = await db.select().from(orders).where(eq(orders.householdId, householdId));
    expect(rows).toHaveLength(0);
  });

  it('rejects a non-existent participant rather than a foreign-key crash (test 7)', async () => {
    const { createOrder } = await import('./orders');
    const { ParticipantNotInHouseholdError } = await import('./errors');
    const { createCustomerId, createHouseholdId, createOccurrenceId } = await import('@keki/contracts');

    const { household, customer } = await seedHouseholdAndCustomer();
    const offering = await seedOffering();
    const occurrence = await seedOccurrence(offering.id);

    await expect(
      createOrder({
        cart: {
          lines: [
            {
              kind: 'OCCURRENCE',
              occurrenceId: createOccurrenceId(occurrence.id),
              participants: [{ kind: 'CUSTOMER', customerId: createCustomerId(crypto.randomUUID()) }],
            },
          ],
        },
        householdId: createHouseholdId(household.id),
        createdByCustomerId: createCustomerId(customer.id),
        seatHolder: unusedSeatHolder(),
      }),
    ).rejects.toBeInstanceOf(ParticipantNotInHouseholdError);
  });

  it('validates participants before resolving prices (test 8)', async () => {
    const { createOrder } = await import('./orders');
    const { ParticipantNotInHouseholdError } = await import('./errors');
    const {
      createCatalogItemId,
      createChildId,
      createCustomerId,
      createHouseholdId,
      createOccurrenceId,
    } = await import('@keki/contracts');

    const { household, customer } = await seedHouseholdAndCustomer();
    const other = await seedHouseholdAndCustomer();
    const foreignChild = await seedChild(other.household.id);
    const archivedItem = await seedCatalogItem({ status: 'ARCHIVED' });
    const offering = await seedOffering();
    const occurrence = await seedOccurrence(offering.id);

    await expect(
      createOrder({
        cart: {
          lines: [
            { kind: 'CATALOG_ITEM', catalogItemId: createCatalogItemId(archivedItem.id), quantity: 1 },
            {
              kind: 'OCCURRENCE',
              occurrenceId: createOccurrenceId(occurrence.id),
              participants: [{ kind: 'CHILD', childId: createChildId(foreignChild.id) }],
            },
          ],
        },
        householdId: createHouseholdId(household.id),
        createdByCustomerId: createCustomerId(customer.id),
        seatHolder: unusedSeatHolder(),
      }),
    ).rejects.toBeInstanceOf(ParticipantNotInHouseholdError);
  });

  it('rejects an archived catalog item (test 9)', async () => {
    const { createOrder } = await import('./orders');
    const { CatalogItemUnavailableError } = await import('./errors');
    const { createCatalogItemId, createCustomerId, createHouseholdId } = await import('@keki/contracts');

    const { household, customer } = await seedHouseholdAndCustomer();
    const item = await seedCatalogItem({ status: 'ARCHIVED' });

    await expect(
      createOrder({
        cart: { lines: [{ kind: 'CATALOG_ITEM', catalogItemId: createCatalogItemId(item.id), quantity: 1 }] },
        householdId: createHouseholdId(household.id),
        createdByCustomerId: createCustomerId(customer.id),
        seatHolder: unusedSeatHolder(),
      }),
    ).rejects.toBeInstanceOf(CatalogItemUnavailableError);
  });

  it('rejects an unknown catalog item (test 10)', async () => {
    const { createOrder } = await import('./orders');
    const { CatalogItemNotFoundError } = await import('./errors');
    const { createCatalogItemId, createCustomerId, createHouseholdId } = await import('@keki/contracts');

    const { household, customer } = await seedHouseholdAndCustomer();

    await expect(
      createOrder({
        cart: {
          lines: [{ kind: 'CATALOG_ITEM', catalogItemId: createCatalogItemId(crypto.randomUUID()), quantity: 1 }],
        },
        householdId: createHouseholdId(household.id),
        createdByCustomerId: createCustomerId(customer.id),
        seatHolder: unusedSeatHolder(),
      }),
    ).rejects.toBeInstanceOf(CatalogItemNotFoundError);
  });

  it('rejects an occurrence whose offering is unpublished (test 11)', async () => {
    const { createOrder } = await import('./orders');
    const { OccurrenceNotBookableError } = await import('./errors');
    const { createCustomerId, createHouseholdId, createOccurrenceId } = await import('@keki/contracts');

    const { household, customer } = await seedHouseholdAndCustomer();
    const offering = await seedOffering({ status: 'DRAFT' });
    const occurrence = await seedOccurrence(offering.id);

    await expect(
      createOrder({
        cart: {
          lines: [
            {
              kind: 'OCCURRENCE',
              occurrenceId: createOccurrenceId(occurrence.id),
              participants: [{ kind: 'CUSTOMER', customerId: createCustomerId(customer.id) }],
            },
          ],
        },
        householdId: createHouseholdId(household.id),
        createdByCustomerId: createCustomerId(customer.id),
        seatHolder: unusedSeatHolder(),
      }),
    ).rejects.toBeInstanceOf(OccurrenceNotBookableError);
  });

  it('rejects a past occurrence (test 12)', async () => {
    const { createOrder } = await import('./orders');
    const { OccurrenceNotBookableError } = await import('./errors');
    const { createCustomerId, createHouseholdId, createOccurrenceId } = await import('@keki/contracts');

    const { household, customer } = await seedHouseholdAndCustomer();
    const offering = await seedOffering();
    const occurrence = await seedOccurrence(offering.id, {
      startsAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    await expect(
      createOrder({
        cart: {
          lines: [
            {
              kind: 'OCCURRENCE',
              occurrenceId: createOccurrenceId(occurrence.id),
              participants: [{ kind: 'CUSTOMER', customerId: createCustomerId(customer.id) }],
            },
          ],
        },
        householdId: createHouseholdId(household.id),
        createdByCustomerId: createCustomerId(customer.id),
        seatHolder: unusedSeatHolder(),
      }),
    ).rejects.toBeInstanceOf(OccurrenceNotBookableError);
  });

  it('rejects a cart whose lines disagree on currency (test 13)', async () => {
    const { createOrder } = await import('./orders');
    const { MixedCurrencyError } = await import('./errors');
    const { createCatalogItemId, createCustomerId, createHouseholdId, createOccurrenceId } = await import(
      '@keki/contracts'
    );

    const { household, customer } = await seedHouseholdAndCustomer();
    const usdItem = await seedCatalogItem({ currency: 'USD' });
    const offering = await seedOffering({ currency: 'EUR' });
    const occurrence = await seedOccurrence(offering.id);

    await expect(
      createOrder({
        cart: {
          lines: [
            { kind: 'CATALOG_ITEM', catalogItemId: createCatalogItemId(usdItem.id), quantity: 1 },
            {
              kind: 'OCCURRENCE',
              occurrenceId: createOccurrenceId(occurrence.id),
              participants: [{ kind: 'CUSTOMER', customerId: createCustomerId(customer.id) }],
            },
          ],
        },
        householdId: createHouseholdId(household.id),
        createdByCustomerId: createCustomerId(customer.id),
        seatHolder: unusedSeatHolder(),
      }),
    ).rejects.toBeInstanceOf(MixedCurrencyError);
  });

  it('writes the seat holder-returned reservationId onto occurrence line items (test 14)', async () => {
    const { createOrder } = await import('./orders');
    const { createCustomerId, createHouseholdId, createOccurrenceId } = await import('@keki/contracts');
    const { db, reservations } = await import('@keki/database');
    const { eq } = await import('drizzle-orm');

    const { household, customer } = await seedHouseholdAndCustomer();
    const offering = await seedOffering();
    const occurrence = await seedOccurrence(offering.id);
    const seatHolder = await realSeatHolder();

    const { lineItems } = await createOrder({
      cart: {
        lines: [
          {
            kind: 'OCCURRENCE',
            occurrenceId: createOccurrenceId(occurrence.id),
            participants: [{ kind: 'CUSTOMER', customerId: createCustomerId(customer.id) }],
          },
        ],
      },
      householdId: createHouseholdId(household.id),
      createdByCustomerId: createCustomerId(customer.id),
      seatHolder,
    });

    const reservationId = lineItems[0]?.reservationId;
    expect(reservationId).not.toBeNull();

    const rows = await db.select().from(reservations).where(eq(reservations.id, reservationId!));
    expect(rows).toHaveLength(1);
  });

  it('holds no seats for a cafe-only order (test 15)', async () => {
    const { createOrder } = await import('./orders');
    const { createCatalogItemId, createCustomerId, createHouseholdId } = await import('@keki/contracts');

    const { household, customer } = await seedHouseholdAndCustomer();
    const item = await seedCatalogItem();
    const holdSeats = vi.fn();

    const { lineItems } = await createOrder({
      cart: { lines: [{ kind: 'CATALOG_ITEM', catalogItemId: createCatalogItemId(item.id), quantity: 3 }] },
      householdId: createHouseholdId(household.id),
      createdByCustomerId: createCustomerId(customer.id),
      seatHolder: { holdSeats },
    });

    expect(holdSeats).not.toHaveBeenCalled();
    expect(lineItems[0]?.occurrenceId).toBeNull();
    expect(lineItems[0]?.reservationId).toBeNull();
  });

  // These five tests use the real reservation-core seat holder (via
  // @keki/reservation-core, a devDependency of this package for tests only —
  // see package-boundaries.test.ts, which checks only the production
  // `dependencies` field) because SC-19's atomicity claim is only true
  // against the real capacity trigger and a real Postgres transaction.
  describe('with the real reservation-core seat holder (SC-19)', () => {
    it('rolls back the whole order when capacity is exceeded (test 16)', async () => {
      const { createOrder } = await import('./orders');
      const { CapacityExceededError, holdReservation } = await import('@keki/reservation-core');
      const { createCustomerId, createHouseholdId, createOccurrenceId } = await import('@keki/contracts');
      const { db, orders } = await import('@keki/database');
      const { eq } = await import('drizzle-orm');

      const offering = await seedOffering({ defaultCapacity: 1 });
      const occurrence = await seedOccurrence(offering.id);
      const occurrenceId = createOccurrenceId(occurrence.id);
      const { household, customer } = await seedHouseholdAndCustomer();
      const occupant = await seedHouseholdAndCustomer();

      await holdReservation({
        occurrenceId,
        householdId: createHouseholdId(occupant.household.id),
        createdByCustomerId: createCustomerId(occupant.customer.id),
        participants: [{ kind: 'CUSTOMER', customerId: createCustomerId(occupant.customer.id) }],
      });

      const householdId = createHouseholdId(household.id);
      const seatHolder = await realSeatHolder();

      await expect(
        createOrder({
          cart: {
            lines: [
              {
                kind: 'OCCURRENCE',
                occurrenceId,
                participants: [{ kind: 'CUSTOMER', customerId: createCustomerId(customer.id) }],
              },
            ],
          },
          householdId,
          createdByCustomerId: createCustomerId(customer.id),
          seatHolder,
        }),
      ).rejects.toBeInstanceOf(CapacityExceededError);

      const orderRows = await db.select().from(orders).where(eq(orders.householdId, householdId));
      expect(orderRows).toHaveLength(0);
    });

    it(
      'releases a held seat when the line-item insert fails after seats are held (test 17)',
      async () => {
        const { createOrder } = await import('./orders');
        const { createCustomerId, createHouseholdId, createOccurrenceId, createReservationId } = await import(
          '@keki/contracts'
        );
        const { db, reservations } = await import('@keki/database');
        const { eq } = await import('drizzle-orm');

        const offeringA = await seedOffering({ defaultCapacity: 5 });
        const occurrenceA = await seedOccurrence(offeringA.id);
        const occurrenceIdA = createOccurrenceId(occurrenceA.id);
        const offeringB = await seedOffering({ defaultCapacity: 5 });
        const occurrenceB = await seedOccurrence(offeringB.id);
        const occurrenceIdB = createOccurrenceId(occurrenceB.id);
        const { household, customer } = await seedHouseholdAndCustomer();

        const inner = await realSeatHolder();
        // Line A holds a genuine seat through reservation-core. Line B
        // returns a reservationId that will never exist as a `reservations`
        // row, so the single batched INSERT into order_line_items — which
        // writes both lines' rows in one statement — violates its FK and
        // fails only after line A's real hold has already landed in this
        // same transaction.
        const seatHolder: SeatHolder = {
          async holdSeats(seatInput) {
            if (seatInput.occurrenceId === occurrenceIdA) {
              return inner.holdSeats(seatInput);
            }
            return {
              occurrenceId: seatInput.occurrenceId,
              reservationId: createReservationId(crypto.randomUUID()),
              seatCount: seatInput.participants.length,
            };
          },
        };

        await expect(
          createOrder({
            cart: {
              lines: [
                {
                  kind: 'OCCURRENCE',
                  occurrenceId: occurrenceIdA,
                  participants: [{ kind: 'CUSTOMER', customerId: createCustomerId(customer.id) }],
                },
                {
                  kind: 'OCCURRENCE',
                  occurrenceId: occurrenceIdB,
                  participants: [{ kind: 'CUSTOMER', customerId: createCustomerId(customer.id) }],
                },
              ],
            },
            householdId: createHouseholdId(household.id),
            createdByCustomerId: createCustomerId(customer.id),
            seatHolder,
          }),
        ).rejects.toThrow();

        const rows = await db.select().from(reservations).where(eq(reservations.occurrenceId, occurrenceA.id));
        expect(rows).toHaveLength(0);
      },
      10_000,
    );

    it('propagates CapacityExceededError unwrapped, carrying the occurrence id (test 18)', async () => {
      const { createOrder } = await import('./orders');
      const { CapacityExceededError, holdReservation } = await import('@keki/reservation-core');
      const { createCustomerId, createHouseholdId, createOccurrenceId } = await import('@keki/contracts');

      const offering = await seedOffering({ defaultCapacity: 1 });
      const occurrence = await seedOccurrence(offering.id);
      const occurrenceId = createOccurrenceId(occurrence.id);
      const { household, customer } = await seedHouseholdAndCustomer();
      const occupant = await seedHouseholdAndCustomer();

      await holdReservation({
        occurrenceId,
        householdId: createHouseholdId(occupant.household.id),
        createdByCustomerId: createCustomerId(occupant.customer.id),
        participants: [{ kind: 'CUSTOMER', customerId: createCustomerId(occupant.customer.id) }],
      });

      const seatHolder = await realSeatHolder();

      const error = await createOrder({
        cart: {
          lines: [
            {
              kind: 'OCCURRENCE',
              occurrenceId,
              participants: [{ kind: 'CUSTOMER', customerId: createCustomerId(customer.id) }],
            },
          ],
        },
        householdId: createHouseholdId(household.id),
        createdByCustomerId: createCustomerId(customer.id),
        seatHolder,
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(CapacityExceededError);
      expect((error as InstanceType<typeof CapacityExceededError>).occurrenceId).toBe(occurrenceId);
    });

    it('rejects only the overflow on a partially-filled class, with full rollback (test 19)', async () => {
      const { createOrder } = await import('./orders');
      const { CapacityExceededError, holdReservation } = await import('@keki/reservation-core');
      const { createChildId, createCustomerId, createHouseholdId, createOccurrenceId } = await import(
        '@keki/contracts'
      );
      const { db, reservations } = await import('@keki/database');
      const { eq } = await import('drizzle-orm');

      const offering = await seedOffering({ defaultCapacity: 3 });
      const occurrence = await seedOccurrence(offering.id);
      const occurrenceId = createOccurrenceId(occurrence.id);
      const { household, customer } = await seedHouseholdAndCustomer();
      const child = await seedChild(household.id);
      const occupant = await seedHouseholdAndCustomer();
      const occupantChild = await seedChild(occupant.household.id);

      // Take 2 of 3 seats, leaving exactly 1.
      await holdReservation({
        occurrenceId,
        householdId: createHouseholdId(occupant.household.id),
        createdByCustomerId: createCustomerId(occupant.customer.id),
        participants: [
          { kind: 'CUSTOMER', customerId: createCustomerId(occupant.customer.id) },
          { kind: 'CHILD', childId: createChildId(occupantChild.id) },
        ],
      });

      const seatHolder = await realSeatHolder();

      await expect(
        createOrder({
          cart: {
            lines: [
              {
                kind: 'OCCURRENCE',
                occurrenceId,
                participants: [
                  { kind: 'CUSTOMER', customerId: createCustomerId(customer.id) },
                  { kind: 'CHILD', childId: createChildId(child.id) },
                ],
              },
            ],
          },
          householdId: createHouseholdId(household.id),
          createdByCustomerId: createCustomerId(customer.id),
          seatHolder,
        }),
      ).rejects.toBeInstanceOf(CapacityExceededError);

      const rows = await db.select().from(reservations).where(eq(reservations.occurrenceId, occurrence.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.seatCount).toBe(2);
    });

    it('passes the order insert transaction handle to the seat holder (test 20)', async () => {
      const { createOrder } = await import('./orders');
      const { createCustomerId, createHouseholdId, createOccurrenceId } = await import('@keki/contracts');
      const { orders } = await import('@keki/database');
      const { and, eq } = await import('drizzle-orm');

      const offering = await seedOffering();
      const occurrence = await seedOccurrence(offering.id);
      const { household, customer } = await seedHouseholdAndCustomer();
      const householdId = createHouseholdId(household.id);

      const inner = await realSeatHolder();
      let sawUncommittedDraftOrder = false;
      const seatHolder: SeatHolder = {
        async holdSeats(seatInput) {
          // If this `tx` is the same handle the orders insert used, that
          // still-uncommitted DRAFT row is visible right here — a separate
          // connection would see nothing yet. This is the check that catches
          // an implementation that silently opens a second connection.
          const rows = await (seatInput.tx as Tx)
            .select()
            .from(orders)
            .where(and(eq(orders.householdId, householdId), eq(orders.status, 'DRAFT')));
          sawUncommittedDraftOrder = rows.length === 1;
          return inner.holdSeats(seatInput);
        },
      };

      await createOrder({
        cart: {
          lines: [
            {
              kind: 'OCCURRENCE',
              occurrenceId: createOccurrenceId(occurrence.id),
              participants: [{ kind: 'CUSTOMER', customerId: createCustomerId(customer.id) }],
            },
          ],
        },
        householdId,
        createdByCustomerId: createCustomerId(customer.id),
        seatHolder,
      });

      expect(sawUncommittedDraftOrder).toBe(true);
    });
  });
});
