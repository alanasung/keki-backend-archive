// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCreateOfferingAction, mockUpdateOfferingAction } = vi.hoisted(() => ({
  mockCreateOfferingAction: vi.fn(),
  mockUpdateOfferingAction: vi.fn(),
}));

vi.mock('../actions/offering-actions', () => ({
  createOfferingAction: mockCreateOfferingAction,
  updateOfferingAction: mockUpdateOfferingAction,
}));

import type { CreateOfferingInput } from '@keki/contracts';
import { OfferingForm } from './offering-form';

function lastCreatePayload(): CreateOfferingInput {
  const calls = mockCreateOfferingAction.mock.calls as unknown as readonly [CreateOfferingInput][];
  const call = calls[calls.length - 1];
  if (call === undefined) {
    throw new Error('createOfferingAction was not called');
  }
  return call[0];
}

function fillRequiredFields(): void {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Yoga 101' } });
  fireEvent.change(screen.getByLabelText('Duration (minutes)'), { target: { value: '60' } });
  fireEvent.change(screen.getByLabelText('Capacity'), { target: { value: '10' } });
  fireEvent.change(screen.getByLabelText('Price (USD)'), { target: { value: '45.00' } });
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

describe('OfferingForm', () => {
  beforeEach(() => {
    mockCreateOfferingAction.mockReset();
    mockUpdateOfferingAction.mockReset();
  });

  // Test 11
  it('renders no offering-type selector, since only CLASS is supported', () => {
    render(<OfferingForm />);

    expect(screen.queryByLabelText(/type/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });

  // Test 9
  it('converts a dollar price to integer cents', async () => {
    mockCreateOfferingAction.mockResolvedValue({ ok: true, data: {} });
    render(<OfferingForm />);

    fillRequiredFields();
    fireEvent.change(screen.getByLabelText('Price (USD)'), { target: { value: '45.50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create offering' }));

    await waitFor(() => expect(mockCreateOfferingAction).toHaveBeenCalledOnce());
    const payload = lastCreatePayload();
    expect(payload.priceCents).toBe(4550);
    expect(Number.isInteger(payload.priceCents)).toBe(true);
  });

  // Test 10
  it('rounds a fractional cent rather than truncating or passing it through as a float', async () => {
    mockCreateOfferingAction.mockResolvedValue({ ok: true, data: {} });
    render(<OfferingForm />);

    fillRequiredFields();
    fireEvent.change(screen.getByLabelText('Price (USD)'), { target: { value: '45.555' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create offering' }));

    await waitFor(() => expect(mockCreateOfferingAction).toHaveBeenCalledOnce());
    const payload = lastCreatePayload();
    expect(payload.priceCents).toBe(4556);
    expect(Number.isInteger(payload.priceCents)).toBe(true);
  });

  // Test 12
  it('calls the create action with parsed values, with duration and capacity arriving as numbers', async () => {
    mockCreateOfferingAction.mockResolvedValue({ ok: true, data: {} });
    render(<OfferingForm />);

    fillRequiredFields();
    fireEvent.click(screen.getByRole('button', { name: 'Create offering' }));

    await waitFor(() => expect(mockCreateOfferingAction).toHaveBeenCalledOnce());
    const payload = lastCreatePayload();
    expect(payload.name).toBe('Yoga 101');
    expect(payload.durationMinutes).toBe(60);
    expect(typeof payload.durationMinutes).toBe('number');
    expect(payload.defaultCapacity).toBe(10);
    expect(typeof payload.defaultCapacity).toBe('number');
  });

  // Test 13
  it('disables the submit control while pending, so a double-click cannot create two offerings', async () => {
    const deferred = createDeferred<{ ok: true; data: unknown }>();
    mockCreateOfferingAction.mockReturnValue(deferred.promise);
    render(<OfferingForm />);

    fillRequiredFields();
    fireEvent.click(screen.getByRole('button', { name: 'Create offering' }));

    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();

    deferred.resolve({ ok: true, data: {} });
    await waitFor(() => expect(mockCreateOfferingAction).toHaveBeenCalledOnce());
  });

  // Test 14
  it('renders the error message from a failed create', async () => {
    mockCreateOfferingAction.mockResolvedValue({
      ok: false,
      error: { code: 'VALIDATION', message: 'Name is required.' },
    });
    render(<OfferingForm />);

    fillRequiredFields();
    fireEvent.click(screen.getByRole('button', { name: 'Create offering' }));

    expect(await screen.findByText('Name is required.')).toBeInTheDocument();
  });
});
