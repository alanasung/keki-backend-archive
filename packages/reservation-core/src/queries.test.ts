import { describe, expect, it, vi } from 'vitest';
import { createChildId, createCustomerId, createOccurrenceId, createReservationId } from '@keki/contracts';

// vi.mock factories are hoisted above all other top-level code, so mock state
// must be created via vi.hoisted() — see packages/auth/src/profile.test.ts
// for the same pattern.
const { mockRows, mockSelect } = vi.hoisted(() => {
  const mockRows = vi.fn<() => unknown[]>(() => []);

  // A single chainable stand-in for drizzle's query builder. Every step
  // (.from/.innerJoin/.where/.limit) returns the same object, and the object
  // itself is thenable so `await db.select()...where(...)` resolves without
  // an explicit `.limit()` call, matching how the real builder behaves.
  function makeBuilder(): PromiseLike<unknown[]> & Record<string, ReturnType<typeof vi.fn>> {
    const builder = {
      from: vi.fn(() => builder),
      innerJoin: vi.fn(() => builder),
      where: vi.fn(() => builder),
      limit: vi.fn(() => Promise.resolve(mockRows())),
      then: (
        onfulfilled?: (value: unknown[]) => unknown,
        onrejected?: (reason: unknown) => unknown,
      ) => Promise.resolve(mockRows()).then(onfulfilled, onrejected),
    };
    return builder as unknown as PromiseLike<unknown[]> & Record<string, ReturnType<typeof vi.fn>>;
  }

  const mockSelect = vi.fn(() => makeBuilder());
  return { mockRows, mockSelect };
});

vi.mock('@keki/database', () => ({
  db: { select: mockSelect },
  reservations: {
    id: 'reservations.id',
    occurrenceId: 'reservations.occurrence_id',
    householdId: 'reservations.household_id',
    status: 'reservations.status',
  },
  reservationParticipants: {
    reservationId: 'reservation_participants.reservation_id',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
}));

import {
  countConfirmedParticipants,
  getReservationById,
  listParticipantsForReservation,
  listReservationsForOccurrence,
} from './queries';

const RESERVATION_ROW = {
  id: '11111111-1111-4111-8111-111111111111',
  occurrenceId: '22222222-2222-4222-8222-222222222222',
  householdId: '33333333-3333-4333-8333-333333333333',
  createdByCustomerId: '44444444-4444-4444-8444-444444444444',
  status: 'CONFIRMED' as const,
  holdExpiresAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

describe('getReservationById', () => {
  it('returns null for an unknown id', async () => {
    mockRows.mockReturnValue([]);

    const result = await getReservationById(createReservationId(RESERVATION_ROW.id));

    expect(result).toBeNull();
  });

  it('maps a found row to a Reservation', async () => {
    mockRows.mockReturnValue([RESERVATION_ROW]);

    const result = await getReservationById(createReservationId(RESERVATION_ROW.id));

    expect(result).not.toBeNull();
    expect(result?.id).toBe(RESERVATION_ROW.id);
    expect(result?.customerId).toBe(RESERVATION_ROW.createdByCustomerId);
  });
});

describe('listReservationsForOccurrence', () => {
  it('returns an empty array, not null, when nothing matches', async () => {
    mockRows.mockReturnValue([]);

    const result = await listReservationsForOccurrence(createOccurrenceId(RESERVATION_ROW.occurrenceId));

    expect(result).toEqual([]);
  });

  it('maps every matching row', async () => {
    mockRows.mockReturnValue([RESERVATION_ROW]);

    const result = await listReservationsForOccurrence(createOccurrenceId(RESERVATION_ROW.occurrenceId));

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(RESERVATION_ROW.id);
  });
});

describe('listParticipantsForReservation', () => {
  it('returns an empty array, not null, when nothing matches', async () => {
    mockRows.mockReturnValue([]);

    const result = await listParticipantsForReservation(createReservationId(RESERVATION_ROW.id));

    expect(result).toEqual([]);
  });

  it('maps a customer row and a child row to their respective refs', async () => {
    const customerId = '77777777-7777-4777-8777-777777777777';
    const childId = '88888888-8888-4888-8888-888888888888';
    mockRows.mockReturnValue([
      { customerId, childId: null },
      { customerId: null, childId },
    ]);

    const result = await listParticipantsForReservation(createReservationId(RESERVATION_ROW.id));

    expect(result).toEqual([
      { kind: 'CUSTOMER', customerId: createCustomerId(customerId) },
      { kind: 'CHILD', childId: createChildId(childId) },
    ]);
  });
});

describe('countConfirmedParticipants', () => {
  it('excludes cancelled and no-show participants', async () => {
    mockRows.mockReturnValue([
      { status: 'CONFIRMED' },
      { status: 'CHECKED_IN' },
      { status: 'CANCELLED' },
      { status: 'NO_SHOW' },
      { status: 'HELD' },
    ]);

    const result = await countConfirmedParticipants(createOccurrenceId(RESERVATION_ROW.occurrenceId));

    expect(result).toBe(2);
  });
});
