// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { URL as NodeURL, fileURLToPath } from 'node:url';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminOccurrenceView } from '@keki/catalog-admin';
import { createOfferingId, createOccurrenceId } from '@keki/contracts';

const { mockListUpcomingOccurrences, mockListOfferings } = vi.hoisted(() => ({
  mockListUpcomingOccurrences: vi.fn(),
  mockListOfferings: vi.fn(),
}));

vi.mock('@keki/catalog-admin', () => ({
  listUpcomingOccurrences: mockListUpcomingOccurrences,
  listOfferings: mockListOfferings,
}));
vi.mock('../actions/occurrence-actions', () => ({
  scheduleOccurrenceAction: vi.fn(),
  updateOccurrenceAction: vi.fn(),
  cancelOccurrenceAction: vi.fn(),
}));

import AdminSchedulesPage from './page';

function occurrenceFixture(overrides: Partial<AdminOccurrenceView> = {}): AdminOccurrenceView {
  const startsAt = overrides.startsAt ?? new Date('2026-01-15T18:00:00Z');
  return {
    occurrenceId: createOccurrenceId(crypto.randomUUID()),
    offeringId: createOfferingId(crypto.randomUUID()),
    offeringName: 'Beginner Pottery',
    offeringStatus: 'PUBLISHED',
    startsAt,
    endsAt: new Date(startsAt.getTime() + 60 * 60 * 1000),
    capacity: 10,
    bookedSeats: 3,
    status: 'SCHEDULED',
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe('AdminSchedulesPage', () => {
  beforeEach(() => {
    mockListUpcomingOccurrences.mockReset();
    mockListOfferings.mockReset().mockResolvedValue([]);
  });

  // Test 1 — SC-14.
  it('renders occurrences grouped by day, ascending, regardless of input order', async () => {
    mockListUpcomingOccurrences.mockResolvedValue([
      occurrenceFixture({ offeringName: 'Latest Day Class', startsAt: new Date('2026-01-20T18:00:00Z') }),
      occurrenceFixture({ offeringName: 'Earliest Day Class', startsAt: new Date('2026-01-10T18:00:00Z') }),
      occurrenceFixture({ offeringName: 'Middle Day Class', startsAt: new Date('2026-01-15T18:00:00Z') }),
    ]);

    render(await AdminSchedulesPage());

    const headings = screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);
    expect(headings).toEqual([
      expect.stringContaining('January 10, 2026'),
      expect.stringContaining('January 15, 2026'),
      expect.stringContaining('January 20, 2026'),
    ]);
  });

  // Test 2
  it('renders times in the cafe timezone, not the server zone', async () => {
    // 2026-01-15T03:00:00Z is 2026-01-14 19:00 in America/Los_Angeles (UTC-8
    // in January) — the previous local calendar day.
    mockListUpcomingOccurrences.mockResolvedValue([occurrenceFixture({ startsAt: new Date('2026-01-15T03:00:00Z') })]);

    render(await AdminSchedulesPage());

    expect(screen.getByText(/January 14, 2026/)).toBeInTheDocument();
    expect(screen.getByText(/7:00 PM/)).toBeInTheDocument();
  });

  // Test 3
  it('imports the shared timezone constant rather than declaring its own', () => {
    const filePath = fileURLToPath(new NodeURL('./page.tsx', import.meta.url));
    const source = readFileSync(filePath, 'utf-8');

    expect(source).toMatch(/import\s*\{\s*CAFE_TIME_ZONE\s*\}\s*from\s*['"]\.\.\/\.\.\/\(customer\)\/book\/class-listing['"]/);
    expect(source).not.toMatch(/CAFE_TIME_ZONE\s*=\s*['"]/);
  });

  // Test 4
  it('renders the booked count against capacity', async () => {
    mockListUpcomingOccurrences.mockResolvedValue([occurrenceFixture({ bookedSeats: 3, capacity: 8 })]);

    render(await AdminSchedulesPage());

    expect(screen.getByText(/3 \/ 8/)).toBeInTheDocument();
  });

  // Test 5
  it('marks an occurrence of an unpublished offering as not visible to customers', async () => {
    mockListUpcomingOccurrences.mockResolvedValue([occurrenceFixture({ offeringStatus: 'DRAFT' })]);

    render(await AdminSchedulesPage());

    expect(screen.getByText(/not visible to customers/i)).toBeInTheDocument();
  });

  // Test 6
  it('does not mark an occurrence of a published offering', async () => {
    mockListUpcomingOccurrences.mockResolvedValue([occurrenceFixture({ offeringStatus: 'PUBLISHED' })]);

    render(await AdminSchedulesPage());

    expect(screen.queryByText(/not visible to customers/i)).not.toBeInTheDocument();
  });

  // Test 7 — SC-08 (list-view half).
  it('shows over-subscription as a problem, with the excess named', async () => {
    mockListUpcomingOccurrences.mockResolvedValue([occurrenceFixture({ bookedSeats: 5, capacity: 2 })]);

    render(await AdminSchedulesPage());

    expect(screen.getByText(/3 over capacity/i)).toBeInTheDocument();
  });

  // Test 8
  it('renders an empty state for an empty schedule rather than a bare heading', async () => {
    mockListUpcomingOccurrences.mockResolvedValue([]);

    render(await AdminSchedulesPage());

    expect(screen.getByRole('status')).toHaveTextContent(/no occurrences scheduled/i);
  });

  it('does not render the placeholder panel', async () => {
    mockListUpcomingOccurrences.mockResolvedValue([]);

    render(await AdminSchedulesPage());

    expect(screen.queryByText(/not built yet/i)).not.toBeInTheDocument();
  });
});
