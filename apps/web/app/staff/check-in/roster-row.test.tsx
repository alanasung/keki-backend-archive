// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReservationId, createReservationParticipantId } from '@keki/contracts';

const { mockCheckInParticipantAction, mockUndoCheckInParticipantAction, mockMarkNoShowAction } = vi.hoisted(() => ({
  mockCheckInParticipantAction: vi.fn(),
  mockUndoCheckInParticipantAction: vi.fn(),
  mockMarkNoShowAction: vi.fn(),
}));

vi.mock('../actions/check-in-actions', () => ({
  checkInParticipantAction: mockCheckInParticipantAction,
  undoCheckInParticipantAction: mockUndoCheckInParticipantAction,
  markNoShowAction: mockMarkNoShowAction,
}));

import { ReservationNoShowControl, RosterRow } from './roster-row';

const PARTICIPANT_ID = createReservationParticipantId('22222222-2222-4222-8222-222222222222');
const OTHER_PARTICIPANT_ID = createReservationParticipantId('33333333-3333-4333-8333-333333333333');
const RESERVATION_ID = createReservationId('44444444-4444-4444-8444-444444444444');

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
});

describe('RosterRow', () => {
  beforeEach(() => {
    mockCheckInParticipantAction.mockReset();
    mockUndoCheckInParticipantAction.mockReset();
    mockMarkNoShowAction.mockReset();
  });

  // Test 2 — staff match a name to a face at a counter.
  it('distinguishes a child participant from an adult', () => {
    render(
      <ul>
        <RosterRow participantId={PARTICIPANT_ID} displayName="Grace Hopper" isChild checkedInAt={null} />
        <RosterRow participantId={OTHER_PARTICIPANT_ID} displayName="Ada Lovelace" isChild={false} checkedInAt={null} />
      </ul>,
    );

    expect(screen.getByText('Grace Hopper').closest('p')).toHaveTextContent('Child');
    expect(screen.getByText('Ada Lovelace').closest('p')).not.toHaveTextContent('Child');
  });

  // Test 3
  it('shows a check-in control and no undo control for an un-arrived participant', () => {
    render(<ul><RosterRow participantId={PARTICIPANT_ID} displayName="Ada Lovelace" isChild={false} checkedInAt={null} /></ul>);

    expect(screen.getByRole('button', { name: 'Check in' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  // Test 4
  it('shows the check-in time and an undo control for an arrived participant, no check-in control', () => {
    render(
      <ul>
        <RosterRow
          participantId={PARTICIPANT_ID}
          displayName="Ada Lovelace"
          isChild={false}
          checkedInAt={new Date('2026-01-15T18:05:00Z')}
        />
      </ul>,
    );

    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check in' })).not.toBeInTheDocument();
  });

  // Test 5 — mocks a UTC instant on the previous local day (America/Los_Angeles).
  it('renders the check-in time in the cafe timezone', () => {
    render(
      <ul>
        <RosterRow
          participantId={PARTICIPANT_ID}
          displayName="Ada Lovelace"
          isChild={false}
          checkedInAt={new Date('2026-01-16T02:15:00Z')}
        />
      </ul>,
    );

    expect(screen.getByText(/6:15 PM/)).toBeInTheDocument();
  });

  // Test 6
  it('calls checkInParticipantAction with only the participant id', async () => {
    mockCheckInParticipantAction.mockResolvedValue({
      ok: true,
      data: {
        participantId: PARTICIPANT_ID,
        reservationId: RESERVATION_ID,
        checkedInAt: new Date('2026-01-15T18:05:00Z'),
        reservationStatus: 'CHECKED_IN',
        changed: true,
      },
    });
    render(<ul><RosterRow participantId={PARTICIPANT_ID} displayName="Ada Lovelace" isChild={false} checkedInAt={null} /></ul>);

    fireEvent.click(screen.getByRole('button', { name: 'Check in' }));

    await waitFor(() => expect(mockCheckInParticipantAction).toHaveBeenCalledOnce());
    const payload = mockCheckInParticipantAction.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).toEqual({ reservationParticipantId: PARTICIPANT_ID });
    expect(payload).not.toHaveProperty('checkedInAt');
    expect(payload).not.toHaveProperty('now');
  });

  // Test 7 — a double-tap must not fire twice.
  it('disables the control while pending', async () => {
    const deferred = createDeferred<{ ok: true; data: { checkedInAt: Date; changed: boolean } }>();
    mockCheckInParticipantAction.mockReturnValue(deferred.promise);
    render(<ul><RosterRow participantId={PARTICIPANT_ID} displayName="Ada Lovelace" isChild={false} checkedInAt={null} /></ul>);

    fireEvent.click(screen.getByRole('button', { name: 'Check in' }));

    expect(screen.getByRole('button', { name: 'Checking in…' })).toBeDisabled();

    deferred.resolve({ ok: true, data: { checkedInAt: new Date('2026-01-15T18:05:00Z'), changed: true } });
    await waitFor(() => expect(mockCheckInParticipantAction).toHaveBeenCalledOnce());
  });

  // Test 8 — a row that vanishes under a finger is how the next person gets
  // checked in by accident.
  it('keeps the row in place after a successful check-in', async () => {
    mockCheckInParticipantAction.mockResolvedValue({
      ok: true,
      data: {
        participantId: PARTICIPANT_ID,
        reservationId: RESERVATION_ID,
        checkedInAt: new Date('2026-01-15T18:05:00Z'),
        reservationStatus: 'CHECKED_IN',
        changed: true,
      },
    });
    render(<ul><RosterRow participantId={PARTICIPANT_ID} displayName="Ada Lovelace" isChild={false} checkedInAt={null} /></ul>);

    fireEvent.click(screen.getByRole('button', { name: 'Check in' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument());
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
  });

  // Test 9 — two staff members tapping the same name is expected, not a failure.
  it('renders "already checked in" for a changed: false success, not as an error', async () => {
    mockCheckInParticipantAction.mockResolvedValue({
      ok: true,
      data: {
        participantId: PARTICIPANT_ID,
        reservationId: RESERVATION_ID,
        checkedInAt: new Date('2026-01-15T18:05:00Z'),
        reservationStatus: 'CHECKED_IN',
        changed: false,
      },
    });
    render(<ul><RosterRow participantId={PARTICIPANT_ID} displayName="Ada Lovelace" isChild={false} checkedInAt={null} /></ul>);

    fireEvent.click(screen.getByRole('button', { name: 'Check in' }));

    const notice = await screen.findByText(/already checked in/i);
    expect(notice).toHaveAttribute('role', 'status');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  // Test 10 — SC-07.
  it('renders a CONFLICT refusal with the reservation status named in the message', async () => {
    mockCheckInParticipantAction.mockResolvedValue({
      ok: false,
      error: { code: 'CONFLICT', message: 'Reservation is HELD and cannot be checked in.' },
    });
    render(<ul><RosterRow participantId={PARTICIPANT_ID} displayName="Ada Lovelace" isChild={false} checkedInAt={null} /></ul>);

    fireEvent.click(screen.getByRole('button', { name: 'Check in' }));

    expect(await screen.findByText(/HELD/)).toHaveAttribute('role', 'alert');
  });

  // Test 11 — one bad booking must not take the screen down mid queue.
  it('does not disturb another row when one row is refused', async () => {
    mockCheckInParticipantAction.mockImplementation((input: { reservationParticipantId: string }) => {
      if (input.reservationParticipantId === PARTICIPANT_ID) {
        return { ok: false, error: { code: 'CONFLICT', message: 'Reservation is HELD and cannot be checked in.' } };
      }
      return {
        ok: true,
        data: {
          participantId: OTHER_PARTICIPANT_ID,
          reservationId: RESERVATION_ID,
          checkedInAt: new Date('2026-01-15T18:05:00Z'),
          reservationStatus: 'CHECKED_IN',
          changed: true,
        },
      };
    });
    render(
      <ul>
        <RosterRow participantId={PARTICIPANT_ID} displayName="Ada Lovelace" isChild={false} checkedInAt={null} />
        <RosterRow participantId={OTHER_PARTICIPANT_ID} displayName="Grace Hopper" isChild={false} checkedInAt={null} />
      </ul>,
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'Check in' })[0]!);
    await screen.findByText(/HELD/);

    expect(screen.getByText('Grace Hopper')).toBeInTheDocument();
    // Both rows still show a check-in control: the first because it was
    // refused, the second because it was never touched.
    expect(screen.getAllByRole('button', { name: 'Check in' })).toHaveLength(2);
  });

  // Test 12
  it('calls undoCheckInParticipantAction with the participant id', async () => {
    mockUndoCheckInParticipantAction.mockResolvedValue({
      ok: true,
      data: { reservationId: RESERVATION_ID, reservationStatus: 'CONFIRMED', changed: true },
    });
    render(
      <ul>
        <RosterRow
          participantId={PARTICIPANT_ID}
          displayName="Ada Lovelace"
          isChild={false}
          checkedInAt={new Date('2026-01-15T18:05:00Z')}
        />
      </ul>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

    await waitFor(() =>
      expect(mockUndoCheckInParticipantAction).toHaveBeenCalledWith({ reservationParticipantId: PARTICIPANT_ID }),
    );
  });
});

describe('ReservationNoShowControl', () => {
  beforeEach(() => {
    mockCheckInParticipantAction.mockReset();
    mockUndoCheckInParticipantAction.mockReset();
    mockMarkNoShowAction.mockReset();
  });

  // Test 21
  it('asks for confirmation before marking a no-show', () => {
    render(
      <ReservationNoShowControl reservationId={RESERVATION_ID} reservationStatus="CONFIRMED" anyCheckedIn={false} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'No-show' }));

    expect(mockMarkNoShowAction).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Confirm no-show' })).toBeInTheDocument();
  });

  // Test 22 — the consequence a staff member cannot otherwise see.
  it('states in the confirmation that seats are released', () => {
    render(
      <ReservationNoShowControl reservationId={RESERVATION_ID} reservationStatus="CONFIRMED" anyCheckedIn={false} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'No-show' }));

    expect(screen.getByText(/releases its seats/i)).toBeInTheDocument();
  });

  // Test 24
  it('renders a CONFLICT refusal message for a no-show', async () => {
    mockMarkNoShowAction.mockResolvedValue({
      ok: false,
      error: { code: 'CONFLICT', message: 'Reservation cannot move from CHECKED_IN to NO_SHOW.' },
    });
    render(
      <ReservationNoShowControl reservationId={RESERVATION_ID} reservationStatus="CONFIRMED" anyCheckedIn={false} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'No-show' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm no-show' }));

    expect(await screen.findByText(/CHECKED_IN to NO_SHOW/)).toHaveAttribute('role', 'alert');
  });
});
