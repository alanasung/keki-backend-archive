// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { URL as NodeURL, fileURLToPath } from 'node:url';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionResult } from '@keki/auth';
import {
  createCatalogItemId,
  createChildId,
  createCustomerId,
  createHouseholdId,
  createOccurrenceId,
  createOfferingId,
  type BookableOccurrenceView,
  type CafeItemView,
  type Child,
  type Customer,
} from '@keki/contracts';

vi.mock('@keki/catalog-core', () => ({
  listCafeItems: vi.fn(),
  listBookableOfferings: vi.fn(),
}));
vi.mock('@keki/customer-core', () => ({
  listHouseholdMembers: vi.fn(),
}));
vi.mock('../../auth/require-session', () => ({
  getSessionResult: vi.fn(),
}));

import { listBookableOfferings, listCafeItems } from '@keki/catalog-core';
import { listHouseholdMembers } from '@keki/customer-core';
import { getSessionResult } from '../../auth/require-session';
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

const SESSION_HOUSEHOLD_ID = createHouseholdId('22222222-2222-4222-8222-222222222222');

// ClassListing (WS-09) loads the session household's members for the
// participant picker footer — a fixture every describe block below that
// renders ClassListing (directly or via BookPage) needs, even when the
// test itself has nothing to do with participants.
const AUTHENTICATED_SESSION_RESULT: SessionResult = {
  kind: 'authenticated',
  session: {
    cognitoSub: 'cognito-sub-1',
    profile: {
      customerId: createCustomerId('11111111-1111-4111-8111-111111111111'),
      householdId: SESSION_HOUSEHOLD_ID,
      email: 'ada@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
      role: 'CUSTOMER',
    },
  },
};

function fixtureCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: createCustomerId('11111111-1111-4111-8111-111111111111'),
    householdId: SESSION_HOUSEHOLD_ID,
    cognitoSub: 'cognito-sub-1',
    email: 'ada@example.com',
    firstName: 'Ada',
    lastName: 'Lovelace',
    phone: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

function fixtureChild(overrides: Partial<Child> = {}): Child {
  return {
    id: createChildId(crypto.randomUUID()),
    householdId: SESSION_HOUSEHOLD_ID,
    firstName: 'Grace',
    lastName: 'Hopper',
    dateOfBirth: new Date('2018-01-01'),
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
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
    vi.mocked(getSessionResult).mockReset().mockResolvedValue(AUTHENTICATED_SESSION_RESULT);
    vi.mocked(listHouseholdMembers).mockReset().mockResolvedValue({ customers: [], children: [] });
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

  // Test 16
  it('offers only the session household in the participant picker, never a member of another household', async () => {
    vi.mocked(listBookableOfferings).mockResolvedValue([occurrence()]);
    vi.mocked(listHouseholdMembers).mockResolvedValue({
      customers: [fixtureCustomer()],
      children: [fixtureChild({ firstName: 'Grace' }), fixtureChild({ firstName: 'Alan' })],
    });

    render(await ClassListing());

    expect(listHouseholdMembers).toHaveBeenCalledWith(SESSION_HOUSEHOLD_ID);
    expect(screen.getAllByRole('checkbox')).toHaveLength(3);
    expect(screen.getByRole('checkbox', { name: /Ada Lovelace/ })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Grace/ })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Alan/ })).toBeInTheDocument();
  });

  // Test 17
  it('offers the account holder as the only option when the household has no children', async () => {
    vi.mocked(listBookableOfferings).mockResolvedValue([occurrence()]);
    vi.mocked(listHouseholdMembers).mockResolvedValue({ customers: [fixtureCustomer()], children: [] });

    render(await ClassListing());

    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    expect(screen.getByRole('checkbox', { name: /Ada Lovelace/ })).toBeInTheDocument();
  });

  // Test 18
  it('derives the seat count in the picker from the selection, with no quantity input', async () => {
    vi.mocked(listBookableOfferings).mockResolvedValue([occurrence({ seatsRemaining: 8 })]);
    vi.mocked(listHouseholdMembers).mockResolvedValue({
      customers: [fixtureCustomer()],
      children: [fixtureChild({ firstName: 'Grace' })],
    });

    render(await ClassListing());

    screen.getByRole('checkbox', { name: /Ada Lovelace/ }).click();
    screen.getByRole('checkbox', { name: /Grace/ }).click();

    expect(screen.getByText('2 seats selected')).toBeInTheDocument();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
  });

  it('omits the picker for a sold-out occurrence', async () => {
    vi.mocked(listBookableOfferings).mockResolvedValue([occurrence({ seatsRemaining: 0 })]);
    vi.mocked(listHouseholdMembers).mockResolvedValue({ customers: [fixtureCustomer()], children: [] });

    render(await ClassListing());

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});

describe('BookPage', () => {
  beforeEach(() => {
    vi.mocked(listCafeItems).mockReset();
    vi.mocked(listBookableOfferings).mockReset();
    vi.mocked(getSessionResult).mockReset().mockResolvedValue(AUTHENTICATED_SESSION_RESULT);
    vi.mocked(listHouseholdMembers).mockReset().mockResolvedValue({ customers: [], children: [] });
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
