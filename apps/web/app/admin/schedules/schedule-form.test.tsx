// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOfferingId, type Offering, type ScheduleOccurrenceInput } from '@keki/contracts';

const { mockScheduleOccurrenceAction } = vi.hoisted(() => ({
  mockScheduleOccurrenceAction: vi.fn(),
}));

vi.mock('../actions/occurrence-actions', () => ({
  scheduleOccurrenceAction: mockScheduleOccurrenceAction,
  updateOccurrenceAction: vi.fn(),
  cancelOccurrenceAction: vi.fn(),
}));

import { ScheduleForm } from './schedule-form';

function offeringFixture(overrides: Partial<Offering> = {}): Offering {
  return {
    id: createOfferingId(crypto.randomUUID()),
    slug: 'yoga-101',
    type: 'CLASS',
    status: 'PUBLISHED',
    name: 'Yoga 101',
    description: null,
    durationMinutes: 60,
    defaultCapacity: 10,
    priceCents: 4500,
    currency: 'USD',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function lastPayload(): ScheduleOccurrenceInput {
  const calls = mockScheduleOccurrenceAction.mock.calls as unknown as readonly [ScheduleOccurrenceInput][];
  const call = calls[calls.length - 1];
  if (call === undefined) {
    throw new Error('scheduleOccurrenceAction was not called');
  }
  return call[0];
}

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

describe('ScheduleForm', () => {
  beforeEach(() => {
    mockScheduleOccurrenceAction.mockReset();
  });

  // Test 9
  it('lists only published offerings in the selector', () => {
    render(
      <ScheduleForm
        offerings={[
          offeringFixture({ name: 'Draft Class', status: 'DRAFT' }),
          offeringFixture({ name: 'Published Class', status: 'PUBLISHED' }),
          offeringFixture({ name: 'Archived Class', status: 'ARCHIVED' }),
        ]}
      />,
    );

    expect(screen.getByRole('option', { name: 'Published Class' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Draft Class' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Archived Class' })).not.toBeInTheDocument();
  });

  // Test 10
  it('renders guidance linking to /admin/offerings when there are no published offerings, not an empty selector', () => {
    render(<ScheduleForm offerings={[offeringFixture({ status: 'DRAFT' })]} />);

    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /offerings/i })).toHaveAttribute('href', '/admin/offerings');
  });

  // Test 11
  it('renders no end-time field, since the end is derived', () => {
    render(<ScheduleForm offerings={[offeringFixture()]} />);

    expect(screen.queryByLabelText(/^end/i)).not.toBeInTheDocument();
  });

  // Test 12
  it('shows the computed end before submitting', () => {
    render(<ScheduleForm offerings={[offeringFixture({ durationMinutes: 90 })]} />);

    fireEvent.change(screen.getByLabelText('Start'), { target: { value: '2026-03-01T10:00' } });

    expect(screen.getByText(/11:30/)).toBeInTheDocument();
  });

  // Test 13
  it('submits an ISO start string, not a Date or a locale-formatted string', async () => {
    mockScheduleOccurrenceAction.mockResolvedValue({ ok: true, data: {} });
    render(<ScheduleForm offerings={[offeringFixture()]} />);

    fireEvent.change(screen.getByLabelText('Start'), { target: { value: '2026-03-01T10:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));

    await vi.waitFor(() => expect(mockScheduleOccurrenceAction).toHaveBeenCalledOnce());
    const payload = lastPayload();
    expect(typeof payload.startsAt).toBe('string');
    expect(payload.startsAt).toBe(new Date('2026-03-01T10:00').toISOString());
  });

  // Test 14
  it('renders a past-date VALIDATION refusal', async () => {
    mockScheduleOccurrenceAction.mockResolvedValue({
      ok: false,
      error: { code: 'VALIDATION', message: 'Occurrence start is not after now.' },
    });
    render(<ScheduleForm offerings={[offeringFixture()]} />);

    fireEvent.change(screen.getByLabelText('Start'), { target: { value: '2020-03-01T10:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));

    expect(await screen.findByText('Occurrence start is not after now.')).toBeInTheDocument();
  });

  // Test 15
  it('renders an overlap CONFLICT refusal naming the conflicting time', async () => {
    mockScheduleOccurrenceAction.mockResolvedValue({
      ok: false,
      error: { code: 'CONFLICT', message: 'Overlaps existing occurrence starting "2026-03-01T18:00:00.000Z".' },
    });
    render(<ScheduleForm offerings={[offeringFixture()]} />);

    fireEvent.change(screen.getByLabelText('Start'), { target: { value: '2026-03-01T10:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));

    expect(await screen.findByText(/Overlaps existing occurrence/)).toBeInTheDocument();
  });

  // Test 22
  it('disables the submit control while pending, so a double-click cannot schedule twice', async () => {
    const deferred = createDeferred<{ ok: true; data: unknown }>();
    mockScheduleOccurrenceAction.mockReturnValue(deferred.promise);
    render(<ScheduleForm offerings={[offeringFixture()]} />);

    fireEvent.change(screen.getByLabelText('Start'), { target: { value: '2026-03-01T10:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));

    expect(screen.getByRole('button', { name: 'Scheduling…' })).toBeDisabled();

    deferred.resolve({ ok: true, data: {} });
    await vi.waitFor(() => expect(mockScheduleOccurrenceAction).toHaveBeenCalledOnce());
  });
});
