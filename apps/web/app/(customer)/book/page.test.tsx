// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { URL as NodeURL, fileURLToPath } from 'node:url';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCatalogItemId,
  createOccurrenceId,
  createOfferingId,
  type BookableOccurrenceView,
  type CafeItemView,
} from '@keki/contracts';

vi.mock('@keki/catalog-core', () => ({
  listCafeItems: vi.fn(),
  listBookableOfferings: vi.fn(),
}));

import { listBookableOfferings, listCafeItems } from '@keki/catalog-core';
import { CafeMenu } from './cafe-menu';
import { ClassListing } from './class-listing';
import BookPage from './page';

afterEach(() => {
  cleanup();
});

function cafeItem(overrides: Partial<CafeItemView> = {}): CafeItemView {
  return {
    catalogItemId: createCatalogItemId(crypto.randomUUID()),
    name: 'Cortado',
    description: 'Double shot, steamed milk',
    priceCents: 450,
    currency: 'USD',
    ...overrides,
  };
}

function occurrence(overrides: Partial<BookableOccurrenceView> = {}): BookableOccurrenceView {
  const startsAt = overrides.startsAt ?? new Date('2026-01-15T18:00:00Z');
  return {
    occurrenceId: createOccurrenceId(crypto.randomUUID()),
    offeringId: createOfferingId(crypto.randomUUID()),
    name: 'Beginner Pottery',
    description: 'Wheel throwing basics',
    startsAt,
    endsAt: new Date(startsAt.getTime() + 60 * 60 * 1000),
    priceCents: 4500,
    currency: 'USD',
    capacity: 10,
    seatsRemaining: 8,
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

describe('CafeMenu', () => {
  beforeEach(() => {
    vi.mocked(listCafeItems).mockReset();
    vi.mocked(listBookableOfferings).mockReset();
  });

  it('lists every item', async () => {
    vi.mocked(listCafeItems).mockResolvedValue([
      cafeItem({ name: 'Cortado' }),
      cafeItem({ name: 'Muffin' }),
      cafeItem({ name: 'Drip Coffee' }),
    ]);

    render(await CafeMenu());

    expect(screen.getAllByRole('article')).toHaveLength(3);
    expect(screen.getByText('Cortado')).toBeInTheDocument();
    expect(screen.getByText('Muffin')).toBeInTheDocument();
    expect(screen.getByText('Drip Coffee')).toBeInTheDocument();
  });

  it('renders an empty state for the never-synced case', async () => {
    vi.mocked(listCafeItems).mockResolvedValue([]);

    render(await CafeMenu());

    expect(screen.queryAllByRole('article')).toHaveLength(0);
    expect(screen.getByRole('status')).toHaveTextContent(/no cafe items/i);
  });
});

describe('ClassListing', () => {
  beforeEach(() => {
    vi.mocked(listCafeItems).mockReset();
    vi.mocked(listBookableOfferings).mockReset();
  });

  it('lists occurrences with time, price, and seats', async () => {
    vi.mocked(listBookableOfferings).mockResolvedValue([
      occurrence({ name: 'Beginner Pottery', startsAt: new Date('2026-01-15T18:00:00Z') }),
      occurrence({ name: 'Advanced Pottery', startsAt: new Date('2026-01-15T20:00:00Z') }),
      occurrence({ name: 'Open Studio', startsAt: new Date('2026-01-16T18:00:00Z') }),
    ]);

    render(await ClassListing());

    expect(screen.getByText('Beginner Pottery')).toBeInTheDocument();
    expect(screen.getByText('Advanced Pottery')).toBeInTheDocument();
    expect(screen.getByText('Open Studio')).toBeInTheDocument();
    // Formatted local start time and price both render per occurrence.
    expect(screen.getAllByText('10:00 AM')).toHaveLength(2);
    expect(screen.getByText('12:00 PM')).toBeInTheDocument();
    expect(screen.getAllByText('$45.00')).toHaveLength(3);
    expect(screen.getAllByText(/seats? left/)).toHaveLength(3);
  });

  it('groups by day in ascending order', async () => {
    vi.mocked(listBookableOfferings).mockResolvedValue([
      occurrence({ name: 'Later Day Class', startsAt: new Date('2026-01-20T18:00:00Z') }),
      occurrence({ name: 'Earlier Day Class', startsAt: new Date('2026-01-10T18:00:00Z') }),
    ]);

    render(await ClassListing());

    const headings = screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent);
    expect(headings).toEqual([
      expect.stringContaining('January 10, 2026'),
      expect.stringContaining('January 20, 2026'),
    ]);
  });

  it('renders start times in the cafe timezone', async () => {
    // 2026-01-15T03:00:00Z is 2026-01-14 19:00 in America/Los_Angeles (UTC-8
    // in January) — the previous local calendar day.
    vi.mocked(listBookableOfferings).mockResolvedValue([
      occurrence({ startsAt: new Date('2026-01-15T03:00:00Z') }),
    ]);

    render(await ClassListing());

    expect(screen.getByText(/January 14, 2026/)).toBeInTheDocument();
    expect(screen.getByText('7:00 PM')).toBeInTheDocument();
  });

  it('labels sold-out occurrences', async () => {
    vi.mocked(listBookableOfferings).mockResolvedValue([occurrence({ seatsRemaining: 0 })]);

    render(await ClassListing());

    expect(screen.getByText('Sold out')).toBeInTheDocument();
  });

  it('surfaces a low-availability hint', async () => {
    vi.mocked(listBookableOfferings).mockResolvedValue([occurrence({ seatsRemaining: 1 })]);

    render(await ClassListing());

    expect(screen.getByText('Only 1 seat left')).toBeInTheDocument();
  });

  it('renders an empty state', async () => {
    vi.mocked(listBookableOfferings).mockResolvedValue([]);

    render(await ClassListing());

    expect(screen.getByRole('status')).toHaveTextContent(/no classes scheduled/i);
  });
});

describe('BookPage', () => {
  beforeEach(() => {
    vi.mocked(listCafeItems).mockReset();
    vi.mocked(listBookableOfferings).mockReset();
  });

  it('renders both the cafe menu and the class listing', async () => {
    vi.mocked(listCafeItems).mockResolvedValue([cafeItem({ name: 'Cortado' })]);
    vi.mocked(listBookableOfferings).mockResolvedValue([occurrence({ name: 'Beginner Pottery' })]);

    render(await BookPage());

    expect(screen.getByText('Cortado')).toBeInTheDocument();
    expect(screen.getByText('Beginner Pottery')).toBeInTheDocument();
  });

  it('fetches both sections concurrently', async () => {
    const cafeDeferred = createDeferred<readonly CafeItemView[]>();
    const classDeferred = createDeferred<readonly BookableOccurrenceView[]>();
    vi.mocked(listCafeItems).mockReturnValue(cafeDeferred.promise);
    vi.mocked(listBookableOfferings).mockReturnValue(classDeferred.promise);

    const pagePromise = BookPage();

    expect(listCafeItems).toHaveBeenCalledTimes(1);
    expect(listBookableOfferings).toHaveBeenCalledTimes(1);

    cafeDeferred.resolve([]);
    classDeferred.resolve([]);
    await pagePromise;
  });

  it('does not render the placeholder panel', async () => {
    vi.mocked(listCafeItems).mockResolvedValue([]);
    vi.mocked(listBookableOfferings).mockResolvedValue([]);

    render(await BookPage());

    expect(screen.queryByText(/not built yet/i)).not.toBeInTheDocument();
  });

  it('is marked dynamic so seat counts are never served from a stale route cache', () => {
    const filePath = fileURLToPath(new NodeURL('./page.tsx', import.meta.url));
    const source = readFileSync(filePath, 'utf-8');

    expect(source).toContain("export const dynamic = 'force-dynamic'");
  });
});
