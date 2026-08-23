// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RosterParticipantView, StaffOccurrenceView } from '@keki/staff-ops';
import { createOccurrenceId, createReservationId, createReservationParticipantId } from '@keki/contracts';

const { mockListTodaysOccurrences, mockListOccurrenceRoster, mockNotFound } = vi.hoisted(() => ({
  mockListTodaysOccurrences: vi.fn(),
  mockListOccurrenceRoster: vi.fn(),
  mockNotFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('@keki/staff-ops', () => ({
  listTodaysOccurrences: mockListTodaysOccurrences,
  listOccurrenceRoster: mockListOccurrenceRoster,
}));
vi.mock('next/navigation', () => ({ notFound: mockNotFound }));
// RosterRow and ReservationNoShowControl import these directly; unused by
// these page-composition tests, so a bare mock is enough.
vi.mock('../actions/check-in-actions', () => ({
  checkInParticipantAction: vi.fn(),
  undoCheckInParticipantAction: vi.fn(),
  markNoShowAction: vi.fn(),
}));

import StaffCheckInPage from './page';

const OCCURRENCE_ID = createOccurrenceId('44444444-4444-4444-8444-444444444444');
const OTHER_OCCURRENCE_ID = createOccurrenceId('55555555-5555-4555-8555-555555555555');
const RESERVATION_ID = createReservationId('66666666-6666-4666-8666-666666666666');
const OTHER_RESERVATION_ID = createReservationId('77777777-7777-4777-8777-777777777777');

function occurrenceFixture(overrides: Partial<StaffOccurrenceView> = {}): StaffOccurrenceView {
  const startsAt = overrides.startsAt ?? new Date('2026-01-15T18:00:00Z');
  return {
    occurrenceId: OCCURRENCE_ID,
    offeringName: 'Beginner Pottery',
    startsAt,
    endsAt: new Date(startsAt.getTime() + 60 * 60 * 1000),
    capacity: 10,
    expectedParticipants: 3,
    arrivedParticipants: 0,
    status: 'SCHEDULED',
    ...overrides,
  };
}

function participantFixture(overrides: Partial<RosterParticipantView> = {}): RosterParticipantView {
  return {
    participantId: createReservationParticipantId(crypto.randomUUID()),
    reservationId: RESERVATION_ID,
    displayName: 'Ada Lovelace',
    isChild: false,
    checkedInAt: null,
    reservationStatus: 'CONFIRMED',
    ...overrides,
  };
}

async function renderPage(occurrenceId?: string) {
  return render(
    await StaffCheckInPage({
      searchParams: Promise.resolve(occurrenceId !== undefined ? { occurrenceId } : {}),
    }),
  );
}

beforeEach(() => {
  mockListTodaysOccurrences.mockReset();
  mockListOccurrenceRoster.mockReset().mockResolvedValue([]);
  mockNotFound.mockClear();
  vi.useFakeTimers();
  // Overlaps the default occurrence fixture's 18:00-19:00Z window, so the
  // default occurrence reads as in-progress unless a test says otherwise.
  vi.setSystemTime(new Date('2026-01-15T18:30:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('StaffCheckInPage', () => {
  // Test 1 — SC-14.
  it("lists an occurrence's participants by name, not by id", async () => {
    mockListTodaysOccurrences.mockResolvedValue([occurrenceFixture()]);
    mockListOccurrenceRoster.mockResolvedValue([
      participantFixture({ participantId: createReservationParticipantId(crypto.randomUUID()), displayName: 'Ada Lovelace' }),
      participantFixture({ participantId: createReservationParticipantId(crypto.randomUUID()), displayName: 'Grace Hopper' }),
      participantFixture({ participantId: createReservationParticipantId(crypto.randomUUID()), displayName: 'Sam Staffer' }),
    ]);

    await renderPage();

    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('Grace Hopper')).toBeInTheDocument();
    expect(screen.getByText('Sam Staffer')).toBeInTheDocument();
  });

  // Test 13 — the view is linkable from /staff/today.
  it('selects the occurrence named in searchParams', async () => {
    mockListTodaysOccurrences.mockResolvedValue([
      occurrenceFixture({ occurrenceId: OCCURRENCE_ID, offeringName: 'Beginner Pottery' }),
      occurrenceFixture({
        occurrenceId: OTHER_OCCURRENCE_ID,
        offeringName: 'Advanced Pottery',
        startsAt: new Date('2026-01-15T20:00:00Z'),
      }),
    ]);
    mockListOccurrenceRoster.mockImplementation((occurrenceId: string) =>
      Promise.resolve(occurrenceId === OTHER_OCCURRENCE_ID ? [participantFixture({ displayName: 'Grace Hopper' })] : []),
    );

    await renderPage(OTHER_OCCURRENCE_ID);

    expect(mockListOccurrenceRoster).toHaveBeenCalledWith(OTHER_OCCURRENCE_ID);
    expect(screen.getByText('Grace Hopper')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Advanced Pottery/ })).toHaveAttribute('aria-current', 'page');
  });

  // Test 14 — landing on a chooser when exactly one class is running is a
  // worse first impression than landing on the roster almost certainly
  // wanted.
  it('defaults to the in-progress occurrence when no searchParams are given', async () => {
    mockListTodaysOccurrences.mockResolvedValue([
      occurrenceFixture({
        occurrenceId: OCCURRENCE_ID,
        offeringName: 'Current Class',
        startsAt: new Date('2026-01-15T18:00:00Z'),
        endsAt: new Date('2026-01-15T19:00:00Z'),
      }),
      occurrenceFixture({
        occurrenceId: OTHER_OCCURRENCE_ID,
        offeringName: 'Later Class',
        startsAt: new Date('2026-01-15T20:00:00Z'),
        endsAt: new Date('2026-01-15T21:00:00Z'),
      }),
    ]);
    mockListOccurrenceRoster.mockImplementation((occurrenceId: string) =>
      Promise.resolve(occurrenceId === OCCURRENCE_ID ? [participantFixture({ displayName: 'Ada Lovelace' })] : []),
    );

    await renderPage();

    expect(mockListOccurrenceRoster).toHaveBeenCalledWith(OCCURRENCE_ID);
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
  });

  // Test 15
  it('renders not-found for an occurrence id that is not among today\'s occurrences', async () => {
    mockListTodaysOccurrences.mockResolvedValue([occurrenceFixture()]);

    await expect(renderPage('99999999-9999-4999-8999-999999999999')).rejects.toThrow();

    expect(mockNotFound).toHaveBeenCalledTimes(1);
  });

  it('renders not-found for a malformed occurrence id rather than crashing', async () => {
    mockListTodaysOccurrences.mockResolvedValue([occurrenceFixture()]);

    await expect(renderPage('not-a-uuid')).rejects.toThrow();

    expect(mockNotFound).toHaveBeenCalledTimes(1);
    expect(mockListOccurrenceRoster).not.toHaveBeenCalled();
  });

  // Test 16
  it('renders "nobody is booked" for an occurrence with no participants', async () => {
    mockListTodaysOccurrences.mockResolvedValue([occurrenceFixture()]);
    mockListOccurrenceRoster.mockResolvedValue([]);

    await renderPage();

    expect(screen.getByRole('status')).toHaveTextContent(/nobody is booked/i);
  });

  // Test 17 — Phase 3 shipped a roster that rendered blank rows here.
  it("renders 'Unknown participant' for a name that does not resolve, not a blank row", async () => {
    mockListTodaysOccurrences.mockResolvedValue([occurrenceFixture()]);
    mockListOccurrenceRoster.mockResolvedValue([participantFixture({ displayName: 'Unknown participant' })]);

    await renderPage();

    expect(screen.getByText('Unknown participant')).toBeInTheDocument();
  });

  // Test 18
  it("lists today's occurrences in the picker and marks the selected one", async () => {
    mockListTodaysOccurrences.mockResolvedValue([
      occurrenceFixture({ occurrenceId: OCCURRENCE_ID, offeringName: 'Beginner Pottery' }),
      occurrenceFixture({
        occurrenceId: OTHER_OCCURRENCE_ID,
        offeringName: 'Advanced Pottery',
        startsAt: new Date('2026-01-15T20:00:00Z'),
      }),
    ]);

    await renderPage(OCCURRENCE_ID);

    expect(screen.getByRole('link', { name: /Beginner Pottery/ })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: /Advanced Pottery/ })).not.toHaveAttribute('aria-current');
  });

  // Test 19
  it('renders guidance linking to /staff/today when today has no occurrences', async () => {
    mockListTodaysOccurrences.mockResolvedValue([]);

    await renderPage();

    expect(mockListOccurrenceRoster).not.toHaveBeenCalled();
    const link = screen.getByRole('link', { name: /today's schedule/i });
    expect(link).toHaveAttribute('href', '/staff/today');
  });

  // Test 20 — NO_SHOW is a reservation-level status, not a participant-level one.
  it('renders the no-show control once per reservation, not once per participant', async () => {
    mockListTodaysOccurrences.mockResolvedValue([occurrenceFixture()]);
    mockListOccurrenceRoster.mockResolvedValue([
      participantFixture({ reservationId: RESERVATION_ID, displayName: 'Ada Lovelace' }),
      participantFixture({ reservationId: RESERVATION_ID, displayName: 'Grace Hopper' }),
      participantFixture({ reservationId: RESERVATION_ID, displayName: 'Sam Staffer' }),
    ]);

    await renderPage();

    expect(screen.getAllByRole('button', { name: 'No-show' })).toHaveLength(1);
  });

  // Test 23 — the server refuses it once anyone has arrived.
  it('renders no no-show control on a reservation with anyone checked in', async () => {
    mockListTodaysOccurrences.mockResolvedValue([occurrenceFixture()]);
    mockListOccurrenceRoster.mockResolvedValue([
      participantFixture({
        reservationId: RESERVATION_ID,
        reservationStatus: 'CHECKED_IN',
        displayName: 'Ada Lovelace',
        checkedInAt: new Date('2026-01-15T18:05:00Z'),
      }),
      participantFixture({
        reservationId: RESERVATION_ID,
        reservationStatus: 'CHECKED_IN',
        displayName: 'Grace Hopper',
        checkedInAt: null,
      }),
      // A second reservation, untouched, still gets its own control.
      participantFixture({
        reservationId: OTHER_RESERVATION_ID,
        reservationStatus: 'CONFIRMED',
        displayName: 'Sam Staffer',
        checkedInAt: null,
      }),
    ]);

    await renderPage();

    expect(screen.getAllByRole('button', { name: 'No-show' })).toHaveLength(1);
  });

  it('does not render PlaceholderPanel', async () => {
    mockListTodaysOccurrences.mockResolvedValue([occurrenceFixture()]);

    await renderPage();

    expect(screen.queryByText(/not built yet/i)).not.toBeInTheDocument();
  });
});
