// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { URL as NodeURL, fileURLToPath } from 'node:url';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffOccurrenceView } from '@keki/staff-ops';
import { createOccurrenceId } from '@keki/contracts';

const { mockListTodaysOccurrences } = vi.hoisted(() => ({
  mockListTodaysOccurrences: vi.fn(),
}));

vi.mock('@keki/staff-ops', () => ({ listTodaysOccurrences: mockListTodaysOccurrences }));

import StaffTodayPage from './page';

function occurrenceFixture(overrides: Partial<StaffOccurrenceView> = {}): StaffOccurrenceView {
  const startsAt = overrides.startsAt ?? new Date('2026-01-15T18:00:00Z');
  return {
    occurrenceId: createOccurrenceId(crypto.randomUUID()),
    offeringName: 'Beginner Pottery',
    startsAt,
    endsAt: new Date(startsAt.getTime() + 60 * 60 * 1000),
    capacity: 10,
    expectedParticipants: 5,
    arrivedParticipants: 2,
    status: 'SCHEDULED',
    ...overrides,
  };
}

beforeEach(() => {
  mockListTodaysOccurrences.mockReset();
  vi.useFakeTimers();
  // A neutral "now" that doesn't overlap any fixture's startsAt/endsAt window
  // above, so tests that don't care about in-progress state aren't affected
  // by it incidentally.
  vi.setSystemTime(new Date('2026-06-01T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('StaffTodayPage', () => {
  // Test 1 — SC-01.
  it('renders occurrences in ascending time order regardless of input order', async () => {
    mockListTodaysOccurrences.mockResolvedValue([
      occurrenceFixture({ offeringName: 'Latest Class', startsAt: new Date('2026-01-15T20:00:00Z') }),
      occurrenceFixture({ offeringName: 'Earliest Class', startsAt: new Date('2026-01-15T14:00:00Z') }),
      occurrenceFixture({ offeringName: 'Middle Class', startsAt: new Date('2026-01-15T18:00:00Z') }),
    ]);

    render(await StaffTodayPage());

    const headings = screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent);
    expect(headings).toEqual(['Earliest Class', 'Middle Class', 'Latest Class']);
  });

  // Test 2
  it('shows the class name and time range on each card', async () => {
    mockListTodaysOccurrences.mockResolvedValue([
      occurrenceFixture({
        offeringName: 'Beginner Pottery',
        startsAt: new Date('2026-01-15T18:00:00Z'),
        endsAt: new Date('2026-01-15T19:00:00Z'),
      }),
    ]);

    render(await StaffTodayPage());

    expect(screen.getByText('Beginner Pottery')).toBeInTheDocument();
    expect(screen.getByText(/10:00 AM/)).toBeInTheDocument();
    expect(screen.getByText(/11:00 AM/)).toBeInTheDocument();
  });

  // Test 3 — SC-02.
  it('renders occurrence times in the cafe timezone, not the server zone', async () => {
    // 2026-01-15T03:00:00Z is 2026-01-14 19:00 in America/Los_Angeles
    // (UTC-8 in January) — the previous local calendar day.
    mockListTodaysOccurrences.mockResolvedValue([
      occurrenceFixture({ startsAt: new Date('2026-01-15T03:00:00Z'), endsAt: new Date('2026-01-15T04:00:00Z') }),
    ]);

    render(await StaffTodayPage());

    expect(screen.getByText(/7:00 PM/)).toBeInTheDocument();
  });

  // Test 4
  it('imports the shared timezone constant rather than declaring its own', () => {
    const filePath = fileURLToPath(new NodeURL('./page.tsx', import.meta.url));
    const source = readFileSync(filePath, 'utf-8');

    expect(source).toMatch(/import\s*\{[^}]*CAFE_TIME_ZONE[^}]*\}\s*from\s*['"]@keki\/contracts['"]/);
    expect(source).not.toMatch(/CAFE_TIME_ZONE\s*=\s*['"]/);
  });

  // Test 5
  it('renders arrived over expected counts', async () => {
    mockListTodaysOccurrences.mockResolvedValue([
      occurrenceFixture({ arrivedParticipants: 2, expectedParticipants: 5 }),
    ]);

    render(await StaffTodayPage());

    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  // Test 6
  it('links each card to check-in for its own occurrence', async () => {
    const occurrence = occurrenceFixture();
    mockListTodaysOccurrences.mockResolvedValue([occurrence]);

    render(await StaffTodayPage());

    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', `/staff/check-in?occurrenceId=${occurrence.occurrenceId}`);
  });

  // Test 7
  it('marks the in-progress occurrence, distinct from a later one', async () => {
    vi.setSystemTime(new Date('2026-01-15T18:30:00Z'));
    mockListTodaysOccurrences.mockResolvedValue([
      occurrenceFixture({
        offeringName: 'Current Class',
        startsAt: new Date('2026-01-15T18:00:00Z'),
        endsAt: new Date('2026-01-15T19:00:00Z'),
      }),
      occurrenceFixture({
        offeringName: 'Later Class',
        startsAt: new Date('2026-01-15T20:00:00Z'),
        endsAt: new Date('2026-01-15T21:00:00Z'),
      }),
    ]);

    render(await StaffTodayPage());

    const badges = screen.getAllByText('In progress');
    expect(badges).toHaveLength(1);
  });

  // Test 8
  it('does not mark a not-yet-started occurrence as in progress', async () => {
    vi.setSystemTime(new Date('2026-01-15T17:00:00Z'));
    mockListTodaysOccurrences.mockResolvedValue([
      occurrenceFixture({ startsAt: new Date('2026-01-15T18:00:00Z'), endsAt: new Date('2026-01-15T19:00:00Z') }),
    ]);

    render(await StaffTodayPage());

    expect(screen.queryByText('In progress')).not.toBeInTheDocument();
  });

  // Test 9
  it('does not mark a finished occurrence as in progress', async () => {
    vi.setSystemTime(new Date('2026-01-15T20:00:00Z'));
    mockListTodaysOccurrences.mockResolvedValue([
      occurrenceFixture({ startsAt: new Date('2026-01-15T18:00:00Z'), endsAt: new Date('2026-01-15T19:00:00Z') }),
    ]);

    render(await StaffTodayPage());

    expect(screen.queryByText('In progress')).not.toBeInTheDocument();
  });

  // Test 10
  it('shows "everyone here" when arrived equals expected and expected is nonzero', async () => {
    mockListTodaysOccurrences.mockResolvedValue([
      occurrenceFixture({ expectedParticipants: 3, arrivedParticipants: 3 }),
    ]);

    render(await StaffTodayPage());

    expect(screen.getByText(/everyone here/i)).toBeInTheDocument();
  });

  // Test 11
  it('does not claim "everyone here" when nobody was expected', async () => {
    mockListTodaysOccurrences.mockResolvedValue([
      occurrenceFixture({ expectedParticipants: 0, arrivedParticipants: 0 }),
    ]);

    render(await StaffTodayPage());

    expect(screen.queryByText(/everyone here/i)).not.toBeInTheDocument();
  });

  // Test 12
  it('does not claim completeness for a partially arrived class', async () => {
    mockListTodaysOccurrences.mockResolvedValue([
      occurrenceFixture({ expectedParticipants: 5, arrivedParticipants: 2 }),
    ]);

    render(await StaffTodayPage());

    expect(screen.queryByText(/everyone here/i)).not.toBeInTheDocument();
  });

  // Test 13
  it('renders an empty state for a day with no classes', async () => {
    mockListTodaysOccurrences.mockResolvedValue([]);

    render(await StaffTodayPage());

    expect(screen.getByRole('status')).toHaveTextContent(/nothing scheduled/i);
  });

  // Test 14
  it("renders the cafe's local date as a heading", async () => {
    // 2026-01-15T03:00:00Z is 2026-01-14 19:00 in America/Los_Angeles.
    vi.setSystemTime(new Date('2026-01-15T03:00:00Z'));
    mockListTodaysOccurrences.mockResolvedValue([]);

    render(await StaffTodayPage());

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('January 14, 2026');
  });

  // Test 18
  it('renders no mutation control', async () => {
    mockListTodaysOccurrences.mockResolvedValue([occurrenceFixture()]);

    render(await StaffTodayPage());

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('does not render PlaceholderPanel', async () => {
    mockListTodaysOccurrences.mockResolvedValue([]);

    render(await StaffTodayPage());

    expect(screen.queryByText(/not built yet/i)).not.toBeInTheDocument();
  });
});
