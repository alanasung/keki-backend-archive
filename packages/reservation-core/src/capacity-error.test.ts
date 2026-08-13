import { describe, expect, it, vi } from 'vitest';
import { createCustomerId, createHouseholdId, createOccurrenceId } from '@keki/contracts';
import type { CartParticipantRef, TransactionScope } from '@keki/contracts';

// `@keki/database` validates DATABASE_URL_* eagerly at module load, so
// importing `./commands` for real would fail wherever those are unset — which
// is every local machine. Stub it: these tests inject their own transaction
// handle and never touch the database, and the table objects are only ever
// passed through to the stubbed executor.
vi.mock('@keki/database', () => ({
  db: {},
  reservations: {},
  reservationParticipants: {},
  withTransaction: vi.fn(),
}));

const { holdReservation } = await import('./commands');
const { CapacityExceededError } = await import('./errors');

// The rest of this package's command coverage is `skipIf(!hasLiveDatabase)`,
// which is correct for anything exercising the trigger itself. But it left
// the *translation* of the trigger's rejection into a domain error with no
// coverage that runs without Neon — and that is exactly where the bug lived:
// `isCapacityExceededError` checked only the top-level `.code`, while Drizzle
// wraps driver errors in a `DrizzleQueryError` and leaves the SQLSTATE on
// `.cause`. Every Drizzle-issued insert therefore failed to translate, and a
// customer booking a full class saw a generic internal error instead of
// "that class just sold out".
//
// `holdReservation` takes an optional `tx`, so the failure can be reproduced
// exactly by injecting an executor that throws the shape the driver produces.
// No database, no module mocking, and it runs in every environment.

const OCCURRENCE_ID = createOccurrenceId('11111111-1111-4111-8111-111111111111');
const HOUSEHOLD_ID = createHouseholdId('22222222-2222-4222-8222-222222222222');
const CUSTOMER_ID = createCustomerId('33333333-3333-4333-8333-333333333333');

const PARTICIPANTS: readonly CartParticipantRef[] = [
  { kind: 'CUSTOMER', customerId: CUSTOMER_ID },
];

/** The driver-level error node-postgres and neon-http both produce. */
function rawSqlStateError(code: string): Error {
  return Object.assign(new Error('capacity_exceeded'), {
    code,
    severity: 'ERROR',
    where: 'PL/pgSQL function check_reservation_capacity() line 38 at RAISE',
  });
}

/** What Drizzle actually surfaces: the driver error wrapped one level down. */
function drizzleWrapped(cause: Error): Error {
  return Object.assign(new Error('Failed query: insert into "reservations" ...'), {
    name: 'DrizzleQueryError',
    cause,
  });
}

/**
 * A transaction handle whose first insert rejects with `error`.
 *
 * `TransactionScope` is intentionally `unknown` in contracts so the package
 * needs no Drizzle dependency, which is why no assertion is needed here.
 */
function txThatFailsWith(error: Error): TransactionScope {
  return {
    insert: () => ({
      values: () => ({
        returning: (): Promise<never> => Promise.reject(error),
      }),
    }),
  };
}

async function hold(tx: TransactionScope): Promise<unknown> {
  return holdReservation({
    occurrenceId: OCCURRENCE_ID,
    householdId: HOUSEHOLD_ID,
    createdByCustomerId: CUSTOMER_ID,
    participants: PARTICIPANTS,
    tx,
  });
}

describe('capacity rejection translation', () => {
  it('translates a Drizzle-wrapped KEKI1 into CapacityExceededError', async () => {
    // The regression test. Before the fix this rejected with the raw
    // DrizzleQueryError, because the SQLSTATE sits on `.cause`.
    await expect(hold(txThatFailsWith(drizzleWrapped(rawSqlStateError('KEKI1'))))).rejects.toBeInstanceOf(
      CapacityExceededError,
    );
  });

  it('translates a raw driver KEKI1 into CapacityExceededError', async () => {
    // The unwrapped shape still reaches this code from the raw-client paths,
    // so both must be recognized rather than swapping one for the other.
    await expect(hold(txThatFailsWith(rawSqlStateError('KEKI1')))).rejects.toBeInstanceOf(
      CapacityExceededError,
    );
  });

  it('carries the occurrence id and requested seat count', async () => {
    // WS-05 propagates this error unwrapped and the UI names the class that
    // sold out, so the payload is load-bearing, not decorative.
    await expect(
      hold(txThatFailsWith(drizzleWrapped(rawSqlStateError('KEKI1')))),
    ).rejects.toMatchObject({
      occurrenceId: OCCURRENCE_ID,
      requestedSeats: PARTICIPANTS.length,
    });
  });

  it('does not translate an unrelated SQLSTATE', async () => {
    // A unique violation is not a capacity rejection. Translating it would
    // tell a customer a class sold out when something else entirely broke.
    const uniqueViolation = drizzleWrapped(rawSqlStateError('23505'));
    await expect(hold(txThatFailsWith(uniqueViolation))).rejects.not.toBeInstanceOf(
      CapacityExceededError,
    );
  });

  it('does not translate a non-database error', async () => {
    await expect(hold(txThatFailsWith(new Error('connection reset')))).rejects.not.toBeInstanceOf(
      CapacityExceededError,
    );
  });

  it('terminates on a self-referential cause chain', async () => {
    // A cyclic `cause` must not spin the cause walk. Asserting it rejects at
    // all is the point; the specific error does not matter.
    const cyclic: Error & { cause?: unknown } = new Error('cyclic');
    cyclic.cause = cyclic;
    await expect(hold(txThatFailsWith(cyclic))).rejects.toThrow();
  });
});
