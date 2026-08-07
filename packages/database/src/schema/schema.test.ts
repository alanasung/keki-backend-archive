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
  LEDGER_REASONS,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_STATUSES,
  OCCURRENCE_STATUSES,
  OFFERING_STATUSES,
  OFFERING_TYPES,
  PAYMENT_STATUSES,
  RESERVATION_STATUSES,
  ROLES,
  WAIVER_STATUSES,
} from '@keki/contracts';
import { getDatabaseEnv } from '../env';
import * as schema from './index';
import {
  ledgerReasonEnum,
  notificationChannelEnum,
  notificationStatusEnum,
  occurrenceStatusEnum,
  offeringStatusEnum,
  offeringTypeEnum,
  paymentStatusEnum,
  reservationStatusEnum,
  roleEnum,
  waiverStatusEnum,
} from './enums';
import { offerings } from './catalog';
import { paymentRecords } from './commerce';
import { customers, households } from './people';
import { waiverRecords } from './compliance';
import { notificationOutbox } from './messaging';
import { playPassLedger, playPasses } from './passes';
import { reservationParticipants } from './reservations';

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
].sort();

function allTables(): PgTable[] {
  return Object.values(schema).filter((value) => is(value, PgTable));
}

describe('schema barrel', () => {
  it('exports exactly the thirteen expected tables', () => {
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
    expect(priceCents?.columnType).toBe('PgInteger');
    expect(amountCents?.columnType).toBe('PgInteger');
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

  it('applies cleanly and creates all thirteen tables', async () => {
    // No parameter interpolation for the name list: drizzle's sql template
    // expands a JS array into ($1, ..., $13) — a row constructor, which
    // `= any(...)` rejects with "op ANY/ALL (array) requires array on right
    // side". Fetch every public table and filter here instead.
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
});
