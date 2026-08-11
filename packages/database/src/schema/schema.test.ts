import { is } from 'drizzle-orm';
import { getTableConfig, PgTable, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { getTableName } from 'drizzle-orm';
import { neonConfig, Pool } from '@neondatabase/serverless';
import { drizzle, type NeonDatabase } from 'drizzle-orm/neon-serverless';
import { migrate } from 'drizzle-orm/neon-serverless/migrator';
import { sql } from 'drizzle-orm';
import ws from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CATALOG_ITEM_STATUSES,
  LEDGER_REASONS,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_STATUSES,
  OCCURRENCE_STATUSES,
  OFFERING_STATUSES,
  OFFERING_TYPES,
  ORDER_LINE_ITEM_KINDS,
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  RESERVATION_STATUSES,
  ROLES,
  WAIVER_STATUSES,
} from '@keki/contracts';
import { getDatabaseEnv } from '../env';
import * as schema from './index';
import {
  catalogItemStatusEnum,
  ledgerReasonEnum,
  notificationChannelEnum,
  notificationStatusEnum,
  occurrenceStatusEnum,
  offeringStatusEnum,
  offeringTypeEnum,
  orderLineItemKindEnum,
  orderStatusEnum,
  paymentStatusEnum,
  reservationStatusEnum,
  roleEnum,
  waiverStatusEnum,
} from './enums';
import { catalogItems, offerings } from './catalog';
import { paymentRecords } from './commerce';
import { customers, households } from './people';
import { waiverRecords } from './compliance';
import { notificationOutbox } from './messaging';
import { orderLineItems, orders } from './orders';
import { playPassLedger, playPasses } from './passes';
import { reservationParticipants, reservations } from './reservations';

const EXPECTED_TABLE_NAMES = [
  'households',
  'customers',
  'children',
  'offerings',
  'occurrences',
  'reservations',
  'reservation_participants',
  'play_passes',
  'play_pass_ledger',
  'waiver_records',
  'payment_records',
  'notification_outbox',
  'staff_audit_log',
  'orders',
  'order_line_items',
  'catalog_items',
].sort();

function allTables(): PgTable[] {
  return Object.values(schema).filter((value) => is(value, PgTable));
}

describe('schema barrel', () => {
  it('exports exactly the sixteen expected tables', () => {
    const tableNames = allTables()
      .map((table) => getTableName(table))
      .sort();
    expect(tableNames).toEqual(EXPECTED_TABLE_NAMES);
  });
});

describe('enums mirror @keki/contracts tuples', () => {
  const cases: Array<[string, readonly string[], readonly string[]]> = [
    ['role', roleEnum.enumValues, ROLES],
    ['offering_type', offeringTypeEnum.enumValues, OFFERING_TYPES],
    ['offering_status', offeringStatusEnum.enumValues, OFFERING_STATUSES],
    ['occurrence_status', occurrenceStatusEnum.enumValues, OCCURRENCE_STATUSES],
    ['reservation_status', reservationStatusEnum.enumValues, RESERVATION_STATUSES],
    ['ledger_reason', ledgerReasonEnum.enumValues, LEDGER_REASONS],
    ['payment_status', paymentStatusEnum.enumValues, PAYMENT_STATUSES],
    ['notification_channel', notificationChannelEnum.enumValues, NOTIFICATION_CHANNELS],
    ['notification_status', notificationStatusEnum.enumValues, NOTIFICATION_STATUSES],
    ['waiver_status', waiverStatusEnum.enumValues, WAIVER_STATUSES],
    ['order_status', orderStatusEnum.enumValues, ORDER_STATUSES],
    ['order_line_item_kind', orderLineItemKindEnum.enumValues, ORDER_LINE_ITEM_KINDS],
    ['catalog_item_status', catalogItemStatusEnum.enumValues, CATALOG_ITEM_STATUSES],
  ];

  it.each(cases)(
    '%s has the same members, in the same order, as its contracts tuple',
    (_name, enumValues, tuple) => {
      expect(enumValues).toEqual([...tuple]);
    },
  );
});

describe('timestamp columns', () => {
  it('every timestamp column is timezone-aware', () => {
    const offenders: string[] = [];
    for (const table of allTables()) {
      const { columns, name: tableName } = getTableConfig(table);
      for (const column of columns) {
        if (column.columnType === 'PgTimestamp' || column.columnType === 'PgTimestampString') {
          const withTimezone = (column as unknown as { withTimezone: boolean }).withTimezone;
          if (!withTimezone) {
            offenders.push(`${tableName}.${column.name}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('money columns', () => {
  it('are integer columns, not numeric or real', () => {
    const priceCents = getTableConfig(offerings).columns.find((c) => c.name === 'price_cents');
    const amountCents = getTableConfig(paymentRecords).columns.find(
      (c) => c.name === 'amount_cents',
    );
    const catalogItemPriceCents = getTableConfig(catalogItems).columns.find(
      (c) => c.name === 'price_cents',
    );
    const subtotalCents = getTableConfig(orders).columns.find((c) => c.name === 'subtotal_cents');
    const unitPriceCents = getTableConfig(orderLineItems).columns.find(
      (c) => c.name === 'unit_price_cents',
    );
    expect(priceCents?.columnType).toBe('PgInteger');
    expect(amountCents?.columnType).toBe('PgInteger');
    expect(catalogItemPriceCents?.columnType).toBe('PgInteger');
    expect(subtotalCents?.columnType).toBe('PgInteger');
    expect(unitPriceCents?.columnType).toBe('PgInteger');
  });
});

describe('idempotency keys', () => {
  it('customers.cognito_sub, waiver_records.provider_reference, and payment_records.provider_payment_id are unique', () => {
    const cognitoSub = getTableConfig(customers).columns.find((c) => c.name === 'cognito_sub');
    const providerReference = getTableConfig(waiverRecords).columns.find(
      (c) => c.name === 'provider_reference',
    );
    const providerPaymentId = getTableConfig(paymentRecords).columns.find(
      (c) => c.name === 'provider_payment_id',
    );
    expect(cognitoSub?.isUnique).toBe(true);
    expect(providerReference?.isUnique).toBe(true);
    expect(providerPaymentId?.isUnique).toBe(true);
  });

  it('catalog_items.square_variation_id and orders.square_order_id are unique', () => {
    const squareVariationId = getTableConfig(catalogItems).columns.find(
      (c) => c.name === 'square_variation_id',
    );
    const squareOrderId = getTableConfig(orders).columns.find(
      (c) => c.name === 'square_order_id',
    );
    expect(squareVariationId?.isUnique).toBe(true);
    expect(squareOrderId?.isUnique).toBe(true);
  });
});

describe('notification_outbox index', () => {
  it('has an index covering (status, available_at)', () => {
    const { indexes } = getTableConfig(notificationOutbox);
    const match = indexes.find((index) => {
      const columnNames = index.config.columns.map((column) =>
        column && 'name' in column ? (column as AnyPgColumn).name : undefined,
      );
      return columnNames[0] === 'status' && columnNames[1] === 'available_at';
    });
    expect(match).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Integration tests (cases 8-10). Require a real Neon branch reachable via
// DATABASE_URL_DIRECT; skipped when that variable is unset (e.g. locally
// without Neon credentials). They run in CI where the branch is provisioned.
// ---------------------------------------------------------------------------

const hasLiveDatabase = Boolean(process.env['DATABASE_URL_DIRECT']);

describe.skipIf(!hasLiveDatabase)('integration: migrations and database-level constraints', () => {
  let pool: Pool;
  let db: NeonDatabase<typeof schema>;

  beforeAll(async () => {
    neonConfig.webSocketConstructor = ws;
    const { direct } = getDatabaseEnv();
    pool = new Pool({ connectionString: direct });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: new URL('../../drizzle', import.meta.url).pathname });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('applies cleanly and creates all sixteen tables', async () => {
    // No parameter interpolation for the name list: drizzle's sql template
    // expands a JS array into a row constructor, which `= any(...)` rejects
    // with "op ANY/ALL (array) requires array on right side". Fetch every
    // public table and filter here instead.
    const result = await db.execute<{ table_name: string }>(sql`
      select table_name from information_schema.tables
      where table_schema = 'public'
    `);
    const foundNames = result.rows
      .map((row) => row.table_name)
      .filter((name) => EXPECTED_TABLE_NAMES.includes(name))
      .sort();
    expect(foundNames).toEqual(EXPECTED_TABLE_NAMES);
  });

  it('rejects UPDATE and DELETE on play_pass_ledger', async () => {
    const [household] = await db
      .insert(households)
      .values({ name: 'Ledger Test Household' })
      .returning();
    const [pass] = await db
      .insert(playPasses)
      .values({
        householdId: household!.id,
        totalCredits: 10,
        remainingCredits: 10,
      })
      .returning();
    const [entry] = await db
      .insert(playPassLedger)
      .values({
        playPassId: pass!.id,
        deltaCredits: 10,
        reason: 'PURCHASE',
      })
      .returning();

    await expect(
      db.execute(sql`update play_pass_ledger set delta_credits = 5 where id = ${entry!.id}`),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`delete from play_pass_ledger where id = ${entry!.id}`),
    ).rejects.toThrow();

    const [unchanged] = await db
      .select()
      .from(playPassLedger)
      .where(sql`id = ${entry!.id}`);
    expect(unchanged?.deltaCredits).toBe(10);
  });

  it('enforces exactly one of customer_id/child_id on reservation_participants', async () => {
    const [household] = await db
      .insert(households)
      .values({ name: 'Participant Test Household' })
      .returning();
    const [customer] = await db
      .insert(customers)
      .values({
        householdId: household!.id,
        cognitoSub: `cognito-${crypto.randomUUID()}`,
        firstName: 'Test',
        lastName: 'Parent',
      })
      .returning();
    const [offering] = await db
      .insert(offerings)
      .values({
        slug: `offering-${crypto.randomUUID()}`,
        name: 'Test Offering',
        type: 'OPEN_PLAY',
        durationMinutes: 60,
        defaultCapacity: 10,
        priceCents: 1000,
      })
      .returning();
    const [occurrence] = await db
      .insert(schema.occurrences)
      .values({
        offeringId: offering!.id,
        startsAt: new Date(),
        endsAt: new Date(Date.now() + 60 * 60 * 1000),
      })
      .returning();
    const [reservation] = await db
      .insert(schema.reservations)
      .values({
        occurrenceId: occurrence!.id,
        householdId: household!.id,
        createdByCustomerId: customer!.id,
        status: 'HELD',
      })
      .returning();

    await expect(
      db.insert(reservationParticipants).values({
        reservationId: reservation!.id,
        customerId: customer!.id,
        childId: null,
      }),
    ).resolves.toBeDefined();

    await expect(
      db.execute(
        sql`insert into reservation_participants (reservation_id, customer_id, child_id) values (${reservation!.id}, ${customer!.id}, ${customer!.id})`,
      ),
    ).rejects.toThrow();

    await expect(
      db.execute(
        sql`insert into reservation_participants (reservation_id, customer_id, child_id) values (${reservation!.id}, null, null)`,
      ),
    ).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // WS-02 fixtures shared by the orders/catalog/capacity tests below.
  // -------------------------------------------------------------------------

  async function seedHouseholdAndCustomer() {
    const [household] = await db
      .insert(households)
      .values({ name: `WS-02 Household ${crypto.randomUUID()}` })
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

  async function seedOffering(defaultCapacity: number) {
    const [offering] = await db
      .insert(offerings)
      .values({
        slug: `offering-${crypto.randomUUID()}`,
        name: 'WS-02 Test Offering',
        type: 'CLASS',
        durationMinutes: 60,
        defaultCapacity,
        priceCents: 1000,
      })
      .returning();
    return offering!;
  }

  async function seedOccurrence(offeringId: string, capacityOverride?: number) {
    const [occurrence] = await db
      .insert(schema.occurrences)
      .values({
        offeringId,
        startsAt: new Date(),
        endsAt: new Date(Date.now() + 60 * 60 * 1000),
        capacityOverride,
      })
      .returning();
    return occurrence!;
  }

  async function seedCatalogItem() {
    const [catalogItem] = await db
      .insert(catalogItems)
      .values({
        squareCatalogObjectId: `object-${crypto.randomUUID()}`,
        squareVariationId: `variation-${crypto.randomUUID()}`,
        name: 'Test Muffin',
        priceCents: 350,
      })
      .returning();
    return catalogItem!;
  }

  async function seedOrder(householdId: string, createdByCustomerId: string) {
    const [order] = await db
      .insert(orders)
      .values({ householdId, createdByCustomerId, subtotalCents: 1000 })
      .returning();
    return order!;
  }

  describe('catalog_items', () => {
    it('rejects a duplicate square_variation_id', async () => {
      const variationId = `variation-${crypto.randomUUID()}`;
      await db.insert(catalogItems).values({
        squareCatalogObjectId: 'object-shared',
        squareVariationId: variationId,
        name: 'Latte - Small',
        priceCents: 450,
      });

      await expect(
        db.insert(catalogItems).values({
          squareCatalogObjectId: 'object-shared',
          squareVariationId: variationId,
          name: 'Latte - Small (duplicate)',
          priceCents: 450,
        }),
      ).rejects.toThrow();
    });
  });

  describe('order_line_items', () => {
    it('rejects CATALOG_ITEM kind with occurrence_id set', async () => {
      const { household, customer } = await seedHouseholdAndCustomer();
      const order = await seedOrder(household.id, customer.id);
      const catalogItem = await seedCatalogItem();
      const offering = await seedOffering(5);
      const occurrence = await seedOccurrence(offering.id);

      await expect(
        db.insert(orderLineItems).values({
          orderId: order.id,
          kind: 'CATALOG_ITEM',
          catalogItemId: catalogItem.id,
          occurrenceId: occurrence.id,
          quantity: 1,
          unitPriceCents: 350,
          nameSnapshot: catalogItem.name,
        }),
      ).rejects.toThrow();
    });

    it('rejects OCCURRENCE kind with catalog_item_id set', async () => {
      const { household, customer } = await seedHouseholdAndCustomer();
      const order = await seedOrder(household.id, customer.id);
      const catalogItem = await seedCatalogItem();
      const offering = await seedOffering(5);
      const occurrence = await seedOccurrence(offering.id);

      await expect(
        db.insert(orderLineItems).values({
          orderId: order.id,
          kind: 'OCCURRENCE',
          catalogItemId: catalogItem.id,
          occurrenceId: occurrence.id,
          quantity: 1,
          unitPriceCents: 1000,
          nameSnapshot: 'Test Class',
        }),
      ).rejects.toThrow();
    });

    it('rejects a line item with neither catalog_item_id nor occurrence_id set', async () => {
      const { household, customer } = await seedHouseholdAndCustomer();
      const order = await seedOrder(household.id, customer.id);

      await expect(
        db.insert(orderLineItems).values({
          orderId: order.id,
          kind: 'CATALOG_ITEM',
          quantity: 1,
          unitPriceCents: 350,
          nameSnapshot: 'Test Muffin',
        }),
      ).rejects.toThrow();
    });

    it('rejects a non-positive quantity', async () => {
      const { household, customer } = await seedHouseholdAndCustomer();
      const order = await seedOrder(household.id, customer.id);
      const catalogItem = await seedCatalogItem();

      await expect(
        db.insert(orderLineItems).values({
          orderId: order.id,
          kind: 'CATALOG_ITEM',
          catalogItemId: catalogItem.id,
          quantity: 0,
          unitPriceCents: 350,
          nameSnapshot: catalogItem.name,
        }),
      ).rejects.toThrow();
    });

    it('cascades from orders on delete, leaving no orphaned line items', async () => {
      const { household, customer } = await seedHouseholdAndCustomer();
      const order = await seedOrder(household.id, customer.id);
      const catalogItem = await seedCatalogItem();
      const [lineItem] = await db
        .insert(orderLineItems)
        .values({
          orderId: order.id,
          kind: 'CATALOG_ITEM',
          catalogItemId: catalogItem.id,
          quantity: 1,
          unitPriceCents: 350,
          nameSnapshot: catalogItem.name,
        })
        .returning();

      await db.delete(orders).where(sql`id = ${order.id}`);

      const remaining = await db
        .select()
        .from(orderLineItems)
        .where(sql`id = ${lineItem!.id}`);
      expect(remaining).toHaveLength(0);
    });
  });

  describe('orders', () => {
    it('rejects a duplicate square_order_id', async () => {
      const { household, customer } = await seedHouseholdAndCustomer();
      const squareOrderId = `square-order-${crypto.randomUUID()}`;
      await db.insert(orders).values({
        householdId: household.id,
        createdByCustomerId: customer.id,
        subtotalCents: 1000,
        squareOrderId,
      });

      await expect(
        db.insert(orders).values({
          householdId: household.id,
          createdByCustomerId: customer.id,
          subtotalCents: 1000,
          squareOrderId,
        }),
      ).rejects.toThrow();
    });
  });

  describe('reservations capacity constraint', () => {
    // The trigger's SQLSTATE surfaces at different depths depending on who
    // issued the statement: a raw node-postgres client rejects with the
    // driver's `DatabaseError` carrying a top-level `.code`, while Drizzle
    // wraps that in a `DrizzleQueryError` and leaves the SQLSTATE on
    // `.cause`. Asserting a fixed shape passes for one path and fails for
    // the other, so match on either by walking the chain — the same thing
    // `isCapacityExceededError` in @keki/reservation-core does.
    function capacitySqlStateOf(error: unknown): string | undefined {
      let current: unknown = error;
      for (let depth = 0; depth < 8; depth += 1) {
        if (typeof current !== 'object' || current === null) {
          return undefined;
        }
        const code = (current as { code?: unknown }).code;
        if (typeof code === 'string') {
          return code;
        }
        current = (current as { cause?: unknown }).cause;
      }
      return undefined;
    }

    async function expectCapacityRejection(promise: Promise<unknown>): Promise<void> {
      let caught: unknown;
      try {
        await promise;
      } catch (error) {
        caught = error;
      }
      expect(caught, 'expected the capacity trigger to reject this insert').toBeDefined();
      expect(capacitySqlStateOf(caught)).toBe('KEKI1');
    }

    async function insertReservation(
      occurrenceId: string,
      householdId: string,
      createdByCustomerId: string,
      status: (typeof RESERVATION_STATUSES)[number],
      seatCount = 1,
    ) {
      return db
        .insert(reservations)
        .values({ occurrenceId, householdId, createdByCustomerId, status, seatCount })
        .returning();
    }

    it('allows reservations that sum exactly to capacity', async () => {
      const { household, customer } = await seedHouseholdAndCustomer();
      const offering = await seedOffering(3);
      const occurrence = await seedOccurrence(offering.id);

      for (let i = 0; i < 3; i += 1) {
        await expect(
          insertReservation(occurrence.id, household.id, customer.id, 'CONFIRMED'),
        ).resolves.toBeDefined();
      }
    });

    it('rejects a reservation that would exceed capacity', async () => {
      const { household, customer } = await seedHouseholdAndCustomer();
      const offering = await seedOffering(2);
      const occurrence = await seedOccurrence(offering.id);

      await insertReservation(occurrence.id, household.id, customer.id, 'CONFIRMED');
      await insertReservation(occurrence.id, household.id, customer.id, 'CONFIRMED');

      await expectCapacityRejection(
        insertReservation(occurrence.id, household.id, customer.id, 'CONFIRMED'),
      );
    });

    it('sums seat_count rather than counting rows', async () => {
      const { household, customer } = await seedHouseholdAndCustomer();
      const offering = await seedOffering(3);
      const occurrence = await seedOccurrence(offering.id);

      await insertReservation(occurrence.id, household.id, customer.id, 'CONFIRMED', 3);

      await expectCapacityRejection(
        insertReservation(occurrence.id, household.id, customer.id, 'CONFIRMED', 1),
      );
    });

    it('resolves effective capacity from capacity_override before default_capacity', async () => {
      const { household, customer } = await seedHouseholdAndCustomer();
      const offering = await seedOffering(2);
      const occurrence = await seedOccurrence(offering.id, 5);

      for (let i = 0; i < 5; i += 1) {
        await expect(
          insertReservation(occurrence.id, household.id, customer.id, 'CONFIRMED'),
        ).resolves.toBeDefined();
      }
    });

    it('frees a seat when a reservation is cancelled', async () => {
      const { household, customer } = await seedHouseholdAndCustomer();
      const offering = await seedOffering(1);
      const occurrence = await seedOccurrence(offering.id);

      const [reservation] = await insertReservation(
        occurrence.id,
        household.id,
        customer.id,
        'CONFIRMED',
      );

      await expectCapacityRejection(
        insertReservation(occurrence.id, household.id, customer.id, 'CONFIRMED'),
      );

      await db
        .update(reservations)
        .set({ status: 'CANCELLED' })
        .where(sql`id = ${reservation!.id}`);

      await expect(
        insertReservation(occurrence.id, household.id, customer.id, 'CONFIRMED'),
      ).resolves.toBeDefined();
    });

    it('treats HELD as seat-consuming: a HELD reservation blocks a later CONFIRMED insert', async () => {
      const { household, customer } = await seedHouseholdAndCustomer();
      const offering = await seedOffering(1);
      const occurrence = await seedOccurrence(offering.id);

      await insertReservation(occurrence.id, household.id, customer.id, 'HELD');

      await expectCapacityRejection(
        insertReservation(occurrence.id, household.id, customer.id, 'CONFIRMED'),
      );
    });

    it('does not double-count the row being updated when moving HELD to CONFIRMED at capacity', async () => {
      const { household, customer } = await seedHouseholdAndCustomer();
      const offering = await seedOffering(1);
      const occurrence = await seedOccurrence(offering.id);

      const [reservation] = await insertReservation(
        occurrence.id,
        household.id,
        customer.id,
        'HELD',
      );

      await expect(
        db
          .update(reservations)
          .set({ status: 'CONFIRMED' })
          .where(sql`id = ${reservation!.id}`),
      ).resolves.toBeDefined();
    });

    it(
      'serializes concurrent inserts on the same occurrence so exactly one oversells',
      async () => {
        const { household, customer } = await seedHouseholdAndCustomer();
        const offering = await seedOffering(1);
        const occurrence = await seedOccurrence(offering.id);

        const { direct } = getDatabaseEnv();
        const rawPool = new Pool({ connectionString: direct });
        const clientA = await rawPool.connect();
        const clientB = await rawPool.connect();

        const insertSql = `insert into reservations (occurrence_id, household_id, created_by_customer_id, status, seat_count)
          values ($1, $2, $3, 'CONFIRMED', 1)`;
        const params = [occurrence.id, household.id, customer.id];

        try {
          await clientA.query('BEGIN');
          await clientA.query(insertSql, params);

          await clientB.query('BEGIN');
          const pendingB = clientB.query(insertSql, params);

          let bSettled: 'resolved' | 'rejected' | undefined;
          pendingB
            .then(() => {
              bSettled = 'resolved';
            })
            .catch(() => {
              bSettled = 'rejected';
            });

          // The occurrence row lock (0002_capacity_constraint.sql step b) must
          // still be held by A's open transaction, so B's insert should be
          // blocked rather than settled at this point.
          await new Promise((resolve) => setTimeout(resolve, 300));
          expect(bSettled).toBeUndefined();

          await clientA.query('COMMIT');

          await expectCapacityRejection(pendingB);
          await clientB.query('ROLLBACK').catch(() => undefined);
        } finally {
          clientA.release();
          clientB.release();
          await rawPool.end();
        }
      },
      10_000,
    );
  });
});
