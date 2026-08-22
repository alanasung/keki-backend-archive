// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminOccurrenceView } from '@keki/catalog-admin';
import { createOccurrenceId, createOfferingId } from '@keki/contracts';

const { mockUpdateOccurrenceAction, mockCancelOccurrenceAction } = vi.hoisted(() => ({
  mockUpdateOccurrenceAction: vi.fn(),
  mockCancelOccurrenceAction: vi.fn(),
}));

vi.mock('../actions/occurrence-actions', () => ({
  scheduleOccurrenceAction: vi.fn(),
  updateOccurrenceAction: mockUpdateOccurrenceAction,
  cancelOccurrenceAction: mockCancelOccurrenceAction,
}));

import { OccurrenceRow } from './occurrence-row';

function occurrenceFixture(overrides: Partial<AdminOccurrenceView> = {}): AdminOccurrenceView {
  const startsAt = overrides.startsAt ?? new Date('2026-01-15T18:00:00Z');
  return {
    occurrenceId: createOccurrenceId(crypto.randomUUID()),
    offeringId: createOfferingId(crypto.randomUUID()),
    offeringName: 'Beginner Pottery',
    offeringStatus: 'PUBLISHED',
    startsAt,
    endsAt: new Date(startsAt.getTime() + 60 * 60 * 1000),
    capacity: 8,
    bookedSeats: 3,
    status: 'SCHEDULED',
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe('OccurrenceRow', () => {
  beforeEach(() => {
    mockUpdateOccurrenceAction.mockReset();
    mockCancelOccurrenceAction.mockReset();
  });

  function openCapacityEditor(): void {
    fireEvent.click(screen.getByRole('button', { name: 'Edit capacity' }));
  }

  function setCapacityAndSave(value: string): void {
    fireEvent.change(screen.getByLabelText('Capacity'), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  }

  // Test 16 — SC-08.
  it('shows a warning naming both numbers when a capacity edit lowers below bookings, not an error', async () => {
    mockUpdateOccurrenceAction.mockResolvedValue({
      ok: true,
      data: { occurrence: {}, bookedSeats: 3 },
    });
    render(<OccurrenceRow occurrence={occurrenceFixture({ capacity: 8 })} />);

    openCapacityEditor();
    setCapacityAndSave('2');

    const warning = await screen.findByText(/3.*booked.*1 over capacity/i);
    expect(warning).toBeInTheDocument();
    expect(warning).not.toHaveAttribute('role', 'alert');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  // Test 17
  it('shows no warning when a capacity edit stays above bookings', async () => {
    mockUpdateOccurrenceAction.mockResolvedValue({
      ok: true,
      data: { occurrence: {}, bookedSeats: 3 },
    });
    render(<OccurrenceRow occurrence={occurrenceFixture({ capacity: 8 })} />);

    openCapacityEditor();
    setCapacityAndSave('10');

    await waitFor(() => expect(mockUpdateOccurrenceAction).toHaveBeenCalledOnce());
    expect(screen.queryByText(/over capacity/i)).not.toBeInTheDocument();
  });

  // Test 18 — SC-09.
  it('renders a refused cancellation with the booked count from the server message', async () => {
    mockCancelOccurrenceAction.mockResolvedValue({
      ok: false,
      error: { code: 'CONFLICT', message: 'Occurrence has 3 confirmed reservation(s) and cannot be cancelled.' },
    });
    render(<OccurrenceRow occurrence={occurrenceFixture()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel class' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm cancel' }));

    expect(await screen.findByText(/3 confirmed reservation/)).toBeInTheDocument();
  });

  // Test 19
  it('asks for confirmation before cancelling', () => {
    render(<OccurrenceRow occurrence={occurrenceFixture()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel class' }));

    expect(mockCancelOccurrenceAction).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Confirm cancel' })).toBeInTheDocument();
  });

  // Test 20
  it('states in the confirmation that customers will lose access', () => {
    render(<OccurrenceRow occurrence={occurrenceFixture()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel class' }));

    expect(screen.getByText(/customer booking page/i)).toBeInTheDocument();
  });

  // Test 21
  it('shows no cancel control on an already-cancelled occurrence', () => {
    render(<OccurrenceRow occurrence={occurrenceFixture({ status: 'CANCELLED' })} />);

    expect(screen.queryByRole('button', { name: 'Cancel class' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit capacity' })).not.toBeInTheDocument();
  });

  it('calls the update action with the occurrence id and the new capacity', async () => {
    mockUpdateOccurrenceAction.mockResolvedValue({ ok: true, data: { occurrence: {}, bookedSeats: 1 } });
    const occurrence = occurrenceFixture();
    render(<OccurrenceRow occurrence={occurrence} />);

    openCapacityEditor();
    setCapacityAndSave('5');

    await waitFor(() => {
      expect(mockUpdateOccurrenceAction).toHaveBeenCalledWith({
        occurrenceId: occurrence.occurrenceId,
        data: { capacityOverride: 5 },
      });
    });
  });

  it('calls the cancel action with the occurrence id after confirming', async () => {
    mockCancelOccurrenceAction.mockResolvedValue({ ok: true, data: {} });
    const occurrence = occurrenceFixture();
    render(<OccurrenceRow occurrence={occurrence} />);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel class' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm cancel' }));

    await waitFor(() => {
      expect(mockCancelOccurrenceAction).toHaveBeenCalledWith({ occurrenceId: occurrence.occurrenceId });
    });
  });
});
