// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { URL as NodeURL, fileURLToPath } from 'node:url';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOccurrenceId } from '@keki/contracts';
import type { OccupancyLine, OccupancySnapshot } from '@keki/staff-ops';

const { mockGetCurrentOccupancy, mockRouterRefresh } = vi.hoisted(() => ({
  mockGetCurrentOccupancy: vi.fn(),
  mockRouterRefresh: vi.fn(),
}));

vi.mock('@keki/staff-ops', () => ({ getCurrentOccupancy: mockGetCurrentOccupancy }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mockRouterRefresh }) }));

import StaffOccupancyPage from './page';

function lineFixture(overrides: Partial<OccupancyLine> = {}): OccupancyLine {
  return {
    occurrenceId: createOccurrenceId(crypto.randomUUID()),
    offeringName: 'Beginner Pottery',
    endsAt: new Date('2026-01-15T19:00:00Z'),
    headcount: 4,
    ...overrides,
  };
}

function snapshotFixture(overrides: Partial<OccupancySnapshot> = {}): OccupancySnapshot {
  const lines = overrides.lines ?? [lineFixture()];
  return {
    asOf: new Date('2026-01-15T18:30:00Z'),
    totalHeadcount: lines.reduce((sum, line) => sum + line.headcount, 0),
    lines,
    ...overrides,
  };
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  mockGetCurrentOccupancy.mockReset();
  mockRouterRefresh.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('StaffOccupancyPage', () => {
  // Test 1 — SC-15.
  it('renders the total headcount', async () => {
    mockGetCurrentOccupancy.mockResolvedValue(
      snapshotFixture({ lines: [lineFixture({ headcount: 3 }), lineFixture({ headcount: 4 })], totalHeadcount: 7 }),
    );

    render(await StaffOccupancyPage());

    expect(screen.getByText('7')).toBeInTheDocument();
  });

  // A headcount of exactly one read "1 people currently in the building".
  it('says "person" for a headcount of one and "people" otherwise', async () => {
    mockGetCurrentOccupancy.mockResolvedValue(
      snapshotFixture({ lines: [lineFixture({ headcount: 1 })], totalHeadcount: 1 }),
    );
    render(await StaffOccupancyPage());
    expect(screen.getByText(/person currently in the building/i)).toBeInTheDocument();
    expect(screen.queryByText(/people currently in the building/i)).not.toBeInTheDocument();

    cleanup();

    mockGetCurrentOccupancy.mockResolvedValue(
      snapshotFixture({ lines: [lineFixture({ headcount: 2 })], totalHeadcount: 2 }),
    );
    render(await StaffOccupancyPage());
    expect(screen.getByText(/people currently in the building/i)).toBeInTheDocument();
  });

  // Test 2
  it('renders a line per in-progress occurrence', async () => {
    mockGetCurrentOccupancy.mockResolvedValue(
      snapshotFixture({
        lines: [
          lineFixture({ offeringName: 'Beginner Pottery', headcount: 4 }),
          lineFixture({ offeringName: 'Advanced Weaving', headcount: 3 }),
        ],
        totalHeadcount: 7,
      }),
    );

    render(await StaffOccupancyPage());

    expect(screen.getByText('Beginner Pottery')).toBeInTheDocument();
    expect(screen.getByText('Advanced Weaving')).toBeInTheDocument();
  });

  // Test 3
  it('the lines sum to the total', async () => {
    mockGetCurrentOccupancy.mockResolvedValue(
      snapshotFixture({
        lines: [lineFixture({ headcount: 4 }), lineFixture({ headcount: 3 })],
        totalHeadcount: 7,
      }),
    );

    render(await StaffOccupancyPage());

    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  // Test 4
  it('shows when each line ends', async () => {
    mockGetCurrentOccupancy.mockResolvedValue(
      snapshotFixture({ lines: [lineFixture({ endsAt: new Date('2026-01-15T19:00:00Z') })] }),
    );

    render(await StaffOccupancyPage());

    expect(screen.getByText(/11:00 AM/)).toBeInTheDocument();
  });

  // Test 5 — 2026-01-15T03:00:00Z is 2026-01-14 19:00 America/Los_Angeles.
  it('renders end times in the cafe timezone', async () => {
    mockGetCurrentOccupancy.mockResolvedValue(
      snapshotFixture({ lines: [lineFixture({ endsAt: new Date('2026-01-15T03:00:00Z') })] }),
    );

    render(await StaffOccupancyPage());

    expect(screen.getByText(/7:00 PM/)).toBeInTheDocument();
  });

  // Test 6 — SC-15.
  it('renders the as-of time', async () => {
    mockGetCurrentOccupancy.mockResolvedValue(snapshotFixture({ asOf: new Date('2026-01-15T18:30:00Z') }));

    render(await StaffOccupancyPage());

    expect(screen.getByText(/10:30 AM/)).toBeInTheDocument();
  });

  // Test 7
  it('states that there is no check-out', async () => {
    mockGetCurrentOccupancy.mockResolvedValue(snapshotFixture());

    render(await StaffOccupancyPage());

    expect(screen.getByText(/left early still counts/i)).toBeInTheDocument();
  });

  // Test 8
  it('states the count covers classes that have not ended', async () => {
    mockGetCurrentOccupancy.mockResolvedValue(snapshotFixture());

    render(await StaffOccupancyPage());

    expect(screen.getByText(/have not yet ended/i)).toBeInTheDocument();
  });

  // Test 9
  it('renders an empty state for an empty building', async () => {
    mockGetCurrentOccupancy.mockResolvedValue(snapshotFixture({ lines: [], totalHeadcount: 0 }));

    render(await StaffOccupancyPage());

    expect(screen.getByRole('status')).toHaveTextContent(/nobody is currently in the building/i);
  });

  // Test 10
  it('does not render an empty building as an error', async () => {
    mockGetCurrentOccupancy.mockResolvedValue(snapshotFixture({ lines: [], totalHeadcount: 0 }));

    render(await StaffOccupancyPage());

    expect(screen.queryByText(/error/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/fail/i)).not.toBeInTheDocument();
  });

  // Test 11
  it('renders a zero headcount as 0, not blank', async () => {
    mockGetCurrentOccupancy.mockResolvedValue(
      snapshotFixture({
        lines: [lineFixture({ offeringName: 'Just Started', headcount: 0 })],
        totalHeadcount: 0,
      }),
    );

    render(await StaffOccupancyPage());

    expect(screen.getByText('Just Started')).toBeInTheDocument();
    expect(screen.getAllByText('0').length).toBeGreaterThan(0);
  });

  // Test 12
  it('renders a refresh control', async () => {
    mockGetCurrentOccupancy.mockResolvedValue(snapshotFixture());

    render(await StaffOccupancyPage());

    expect(screen.getByRole('button', { name: /refresh/i })).toBeInTheDocument();
  });

  // Test 13
  it('calls router.refresh() on press', async () => {
    mockGetCurrentOccupancy.mockResolvedValue(snapshotFixture());
    mockRouterRefresh.mockResolvedValue(undefined);
    render(await StaffOccupancyPage());

    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));

    await waitFor(() => expect(mockRouterRefresh).toHaveBeenCalledOnce());
  });

  // Test 14
  it('disables the refresh control while in flight', async () => {
    mockGetCurrentOccupancy.mockResolvedValue(snapshotFixture());
    const deferred = createDeferred<void>();
    mockRouterRefresh.mockReturnValue(deferred.promise);
    render(await StaffOccupancyPage());

    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));

    expect(screen.getByRole('button', { name: /refresh/i })).toBeDisabled();

    deferred.resolve();
    await waitFor(() => expect(screen.getByRole('button', { name: /refresh/i })).not.toBeDisabled());
  });

  // Test 15
  it('renders no mutation control', async () => {
    mockGetCurrentOccupancy.mockResolvedValue(
      snapshotFixture({
        lines: [lineFixture({ offeringName: 'Beginner Pottery' }), lineFixture({ offeringName: 'Advanced Weaving' })],
      }),
    );

    render(await StaffOccupancyPage());

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAccessibleName(/refresh/i);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  // Test 16
  it('is dynamic, not cached', () => {
    const filePath = fileURLToPath(new NodeURL('./page.tsx', import.meta.url));
    const source = readFileSync(filePath, 'utf-8');

    expect(source).toMatch(/export const dynamic = ['"]force-dynamic['"]/);
  });
});
