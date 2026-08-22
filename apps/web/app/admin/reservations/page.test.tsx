// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminOccurrenceView } from '@keki/catalog-admin';
import type { Child, Customer, Reservation } from '@keki/contracts';
import {
  createChildId,
  createCustomerId,
  createHouseholdId,
  createOccurrenceId,
  createOfferingId,
  createReservationId,
} from '@keki/contracts';

const {
  mockListUpcomingOccurrences,
  mockListReservationsForOccurrence,
  mockListParticipantsForReservation,
  mockGetCustomerById,
  mockListHouseholdMembers,
  mockNotFound,
} = vi.hoisted(() => ({
  mockListUpcomingOccurrences: vi.fn(),
  mockListReservationsForOccurrence: vi.fn(),
  mockListParticipantsForReservation: vi.fn(),
  mockGetCustomerById: vi.fn(),
  mockListHouseholdMembers: vi.fn(),
  mockNotFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('@keki/catalog-admin', () => ({ listUpcomingOccurrences: mockListUpcomingOccurrences }));
vi.mock('@keki/reservation-core', () => ({
  listReservationsForOccurrence: mockListReservationsForOccurrence,
  listParticipantsForReservation: mockListParticipantsForReservation,
}));
vi.mock('@keki/customer-core', () => ({
  getCustomerById: mockGetCustomerById,
  listHouseholdMembers: mockListHouseholdMembers,
}));
vi.mock('next/navigation', () => ({ notFound: mockNotFound }));

import AdminReservationsPage from './page';

const HOUSEHOLD_ID = createHouseholdId('11111111-1111-4111-8111-111111111111');
const CUSTOMER_ID = createCustomerId('22222222-2222-4222-8222-222222222222');
const CHILD_ID = createChildId('33333333-3333-4333-8333-333333333333');
const OCCURRENCE_ID = createOccurrenceId('44444444-4444-4444-8444-444444444444');
const OTHER_OCCURRENCE_ID = createOccurrenceId('55555555-5555-4555-8555-555555555555');

function occurrenceFixture(overrides: Partial<AdminOccurrenceView> = {}): AdminOccurrenceView {
  const startsAt = overrides.startsAt ?? new Date('2026-01-15T18:00:00Z');
  return {
    occurrenceId: OCCURRENCE_ID,
    offeringId: createOfferingId(crypto.randomUUID()),
    offeringName: 'Beginner Pottery',
    offeringStatus: 'PUBLISHED',
    startsAt,
    endsAt: new Date(startsAt.getTime() + 60 * 60 * 1000),
    capacity: 10,
    bookedSeats: 0,
    status: 'SCHEDULED',
    ...overrides,
  };
}

function reservationFixture(overrides: Partial<Reservation> = {}): Reservation {
  return {
    id: createReservationId(crypto.randomUUID()),
    occurrenceId: OCCURRENCE_ID,
    customerId: CUSTOMER_ID,
    status: 'CONFIRMED',
    holdExpiresAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function customerFixture(overrides: Partial<Customer> = {}): Customer {
  return {
    id: CUSTOMER_ID,
    householdId: HOUSEHOLD_ID,
    cognitoSub: 'cognito-sub-1',
    email: 'ada@example.com',
    firstName: 'Ada',
    lastName: 'Lovelace',
    phone: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function childFixture(overrides: Partial<Child> = {}): Child {
  return {
    id: CHILD_ID,
    householdId: HOUSEHOLD_ID,
    firstName: 'Grace',
    lastName: 'Hopper',
    dateOfBirth: new Date('2018-01-01'),
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

async function renderPage(occurrenceId?: string) {
  return render(
    await AdminReservationsPage({
      searchParams: Promise.resolve(occurrenceId !== undefined ? { occurrenceId } : {}),
    }),
  );
}

beforeEach(() => {
  mockListUpcomingOccurrences.mockReset().mockResolvedValue([occurrenceFixture()]);
  mockListReservationsForOccurrence.mockReset().mockResolvedValue([]);
  mockListParticipantsForReservation.mockReset().mockResolvedValue([]);
  mockGetCustomerById.mockReset().mockResolvedValue(customerFixture());
  mockListHouseholdMembers.mockReset().mockResolvedValue({ customers: [customerFixture()], children: [childFixture()] });
  mockNotFound.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('AdminReservationsPage', () => {
  // Test 1 — SC-15.
  it('lists a booked child participant by name', async () => {
    mockListReservationsForOccurrence.mockResolvedValue([reservationFixture({ status: 'CONFIRMED' })]);
    mockListParticipantsForReservation.mockResolvedValue([{ kind: 'CHILD', childId: CHILD_ID }]);

    await renderPage();

    expect(screen.getByText('Grace Hopper')).toBeInTheDocument();
  });

  // Test 2
  it('renders a customer participant by name', async () => {
    mockListReservationsForOccurrence.mockResolvedValue([reservationFixture({ status: 'CONFIRMED' })]);
    mockListParticipantsForReservation.mockResolvedValue([{ kind: 'CUSTOMER', customerId: CUSTOMER_ID }]);

    await renderPage();

    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
  });

  // Test 3
  it('renders every participant on one reservation', async () => {
    mockListReservationsForOccurrence.mockResolvedValue([reservationFixture({ status: 'CONFIRMED' })]);
    mockListParticipantsForReservation.mockResolvedValue([
      { kind: 'CUSTOMER', customerId: CUSTOMER_ID },
      { kind: 'CHILD', childId: CHILD_ID },
    ]);

    await renderPage();

    expect(screen.getByText(/Ada Lovelace/)).toBeInTheDocument();
    expect(screen.getByText(/Grace Hopper/)).toBeInTheDocument();
  });

  // Test 4
  it('renders a fallback for an unresolvable participant rather than throwing', async () => {
    mockListReservationsForOccurrence.mockResolvedValue([reservationFixture({ status: 'CONFIRMED' })]);
    mockListParticipantsForReservation.mockResolvedValue([
      { kind: 'CHILD', childId: createChildId('99999999-9999-4999-8999-999999999999') },
    ]);

    await expect(renderPage()).resolves.toBeDefined();

    expect(screen.getByText('Unknown participant')).toBeInTheDocument();
  });

  // Test 4b — a reservation with *no* participant rows at all, which is
  // distinct from test 4's ref-that-does-not-resolve. Without a fallback the
  // row renders completely blank (`[].join(', ')` is the empty string) on the
  // one page whose purpose is showing who is booked.
  it('renders a fallback for a reservation with no participants rather than a blank row', async () => {
    mockListReservationsForOccurrence.mockResolvedValue([reservationFixture({ status: 'CANCELLED' })]);
    mockListParticipantsForReservation.mockResolvedValue([]);

    await expect(renderPage()).resolves.toBeDefined();

    expect(screen.getByText('No participants recorded')).toBeInTheDocument();
    expect(screen.queryByText('Unknown participant')).not.toBeInTheDocument();
  });

  // Test 5
  it('shows reservation status per row, distinctly', async () => {
    mockListReservationsForOccurrence.mockResolvedValue([
      reservationFixture({ status: 'CONFIRMED' }),
      reservationFixture({ status: 'HELD' }),
    ]);
    mockListParticipantsForReservation.mockResolvedValue([{ kind: 'CUSTOMER', customerId: CUSTOMER_ID }]);

    await renderPage();

    expect(screen.getByText('Confirmed')).toBeInTheDocument();
    expect(screen.getByText('Held')).toBeInTheDocument();
  });

  // Test 6
  it('groups confirmed reservations before held ones', async () => {
    mockListReservationsForOccurrence.mockResolvedValue([
      reservationFixture({ status: 'HELD' }),
      reservationFixture({ status: 'CONFIRMED' }),
    ]);
    mockListParticipantsForReservation.mockResolvedValue([{ kind: 'CUSTOMER', customerId: CUSTOMER_ID }]);

    await renderPage();

    const badges = screen.getAllByText(/Confirmed|Held/).map((el) => el.textContent);
    expect(badges).toEqual(['Confirmed', 'Held']);
  });

  // Test 7
  it('sums seat counts across confirmed reservations', async () => {
    const first = reservationFixture({ id: createReservationId(crypto.randomUUID()), status: 'CONFIRMED' });
    const second = reservationFixture({ id: createReservationId(crypto.randomUUID()), status: 'CONFIRMED' });
    mockListReservationsForOccurrence.mockResolvedValue([first, second]);
    mockListParticipantsForReservation.mockImplementation((reservationId: string) => {
      if (reservationId === first.id) {
        return [
          { kind: 'CUSTOMER', customerId: CUSTOMER_ID },
          { kind: 'CHILD', childId: CHILD_ID },
        ];
      }
      return [{ kind: 'CUSTOMER', customerId: CUSTOMER_ID }];
    });

    await renderPage();

    expect(screen.getByText('3 / 10 booked')).toBeInTheDocument();
  });

  // Test 8
  it('counts the same statuses listUpcomingOccurrences counts, excluding cancelled seats', async () => {
    const held = reservationFixture({ id: createReservationId(crypto.randomUUID()), status: 'HELD' });
    const cancelled = reservationFixture({ id: createReservationId(crypto.randomUUID()), status: 'CANCELLED' });
    mockListReservationsForOccurrence.mockResolvedValue([held, cancelled]);
    mockListParticipantsForReservation.mockImplementation((reservationId: string) => {
      if (reservationId === held.id) {
        return [{ kind: 'CUSTOMER', customerId: CUSTOMER_ID }, { kind: 'CHILD', childId: CHILD_ID }];
      }
      // A cancelled reservation's five seats must not count toward the total.
      return [
        { kind: 'CUSTOMER', customerId: CUSTOMER_ID },
        { kind: 'CHILD', childId: CHILD_ID },
        { kind: 'CUSTOMER', customerId: CUSTOMER_ID },
        { kind: 'CUSTOMER', customerId: CUSTOMER_ID },
        { kind: 'CUSTOMER', customerId: CUSTOMER_ID },
      ];
    });

    await renderPage();

    expect(screen.getByText('2 / 10 booked')).toBeInTheDocument();
  });

  // Test 9
  it('renders "no bookings yet" for an occurrence with no reservations', async () => {
    mockListReservationsForOccurrence.mockResolvedValue([]);

    await renderPage();

    expect(screen.getByText(/no bookings yet/i)).toBeInTheDocument();
  });

  // Test 10
  it('selects the occurrence named in searchParams', async () => {
    mockListUpcomingOccurrences.mockResolvedValue([
      occurrenceFixture({ occurrenceId: OCCURRENCE_ID, offeringName: 'Beginner Pottery' }),
      occurrenceFixture({ occurrenceId: OTHER_OCCURRENCE_ID, offeringName: 'Advanced Pottery' }),
    ]);

    await renderPage(OTHER_OCCURRENCE_ID);

    expect(screen.getByRole('heading', { level: 2, name: 'Advanced Pottery' })).toBeInTheDocument();
    expect(mockListReservationsForOccurrence).toHaveBeenCalledWith(OTHER_OCCURRENCE_ID);
  });

  // Test 11
  it('defaults to the next upcoming occurrence when none is selected', async () => {
    mockListUpcomingOccurrences.mockResolvedValue([
      occurrenceFixture({
        occurrenceId: OTHER_OCCURRENCE_ID,
        offeringName: 'Later Class',
        startsAt: new Date('2026-02-01T18:00:00Z'),
      }),
      occurrenceFixture({
        occurrenceId: OCCURRENCE_ID,
        offeringName: 'Earlier Class',
        startsAt: new Date('2026-01-10T18:00:00Z'),
      }),
    ]);

    await renderPage();

    expect(screen.getByRole('heading', { level: 2, name: 'Earlier Class' })).toBeInTheDocument();
    expect(mockListReservationsForOccurrence).toHaveBeenCalledWith(OCCURRENCE_ID);
  });

  // Test 12
  it('404s for an unknown occurrence id', async () => {
    mockListUpcomingOccurrences.mockResolvedValue([occurrenceFixture()]);

    await expect(renderPage('99999999-9999-4999-8999-999999999999')).rejects.toThrow();

    expect(mockNotFound).toHaveBeenCalledTimes(1);
  });

  it('404s for a malformed occurrence id', async () => {
    mockListUpcomingOccurrences.mockResolvedValue([occurrenceFixture()]);

    await expect(renderPage('not-a-uuid')).rejects.toThrow();

    expect(mockNotFound).toHaveBeenCalledTimes(1);
    expect(mockListReservationsForOccurrence).not.toHaveBeenCalled();
  });

  // Test 13
  it('renders no mutation control of any kind', async () => {
    mockListReservationsForOccurrence.mockResolvedValue([reservationFixture({ status: 'CONFIRMED' })]);
    mockListParticipantsForReservation.mockResolvedValue([{ kind: 'CUSTOMER', customerId: CUSTOMER_ID }]);

    await renderPage();

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /check.?in/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /cancel/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^edit$/i })).not.toBeInTheDocument();
  });

  // Test 14
  it('loads household members once per household, not per reservation', async () => {
    mockListReservationsForOccurrence.mockResolvedValue([
      reservationFixture({ id: createReservationId(crypto.randomUUID()), customerId: CUSTOMER_ID }),
      reservationFixture({ id: createReservationId(crypto.randomUUID()), customerId: CUSTOMER_ID }),
      reservationFixture({ id: createReservationId(crypto.randomUUID()), customerId: CUSTOMER_ID }),
    ]);
    mockListParticipantsForReservation.mockResolvedValue([{ kind: 'CUSTOMER', customerId: CUSTOMER_ID }]);
    mockGetCustomerById.mockResolvedValue(customerFixture({ householdId: HOUSEHOLD_ID }));

    await renderPage();

    expect(mockListHouseholdMembers).toHaveBeenCalledTimes(1);
  });

  it('does not render PlaceholderPanel', async () => {
    await renderPage();

    expect(screen.queryByText(/not built yet/i)).not.toBeInTheDocument();
  });
});
