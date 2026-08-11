// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session, SessionResult } from '@keki/auth';
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

const dir = dirname(fileURLToPath(import.meta.url));

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
vi.mock('./cart-cookie', () => ({
  readCart: vi.fn(),
  writeCart: vi.fn(),
  clearCart: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@keki/auth', async () => {
  const actual = await vi.importActual<typeof import('@keki/auth')>('@keki/auth');
  return { ...actual, authorize: vi.fn() };
});
// checkout-action.ts transitively imports the composition root
// (server-clients.ts), which imports the `server-only` package — this
// mock keeps that out of this page-rendering test's dependency graph
// entirely; checkout-action.test.ts covers the action itself.
vi.mock('./checkout-action', () => ({ checkoutAction: vi.fn() }));

import { listBookableOfferings, listCafeItems } from '@keki/catalog-core';
import { listHouseholdMembers } from '@keki/customer-core';
import { getSessionResult } from '../../auth/require-session';
import { readCart } from './cart-cookie';
import CartPage from './page';

const HOUSEHOLD_ID = createHouseholdId('11111111-1111-4111-8111-111111111111');
const CUSTOMER_ID = createCustomerId('22222222-2222-4222-8222-222222222222');
const CHILD_ID = createChildId('33333333-3333-4333-8333-333333333333');
const CATALOG_ITEM_ID = createCatalogItemId('44444444-4444-4444-8444-444444444444');
const OCCURRENCE_ID = createOccurrenceId('55555555-5555-4555-8555-555555555555');

function fixtureCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: CUSTOMER_ID,
    householdId: HOUSEHOLD_ID,
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
    id: CHILD_ID,
    householdId: HOUSEHOLD_ID,
    firstName: 'Grace',
    lastName: 'Hopper',
    dateOfBirth: new Date('2018-01-01'),
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

function fixtureSession(): Session {
  return {
    cognitoSub: 'cognito-sub-1',
    profile: {
      customerId: CUSTOMER_ID,
      householdId: HOUSEHOLD_ID,
      email: 'ada@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
      role: 'CUSTOMER',
    },
  };
}

function cafeItem(overrides: Partial<CafeItemView> = {}): CafeItemView {
  return {
    catalogItemId: CATALOG_ITEM_ID,
    name: 'Cortado',
    description: null,
    priceCents: 500,
    currency: 'USD',
    ...overrides,
  };
}

function occurrence(overrides: Partial<BookableOccurrenceView> = {}): BookableOccurrenceView {
  const startsAt = overrides.startsAt ?? new Date('2026-03-01T18:00:00Z');
  return {
    occurrenceId: OCCURRENCE_ID,
    offeringId: createOfferingId('66666666-6666-4666-8666-666666666666'),
    name: 'Beginner Pottery',
    description: null,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 60 * 60 * 1000),
    priceCents: 4500,
    currency: 'USD',
    capacity: 10,
    seatsRemaining: 8,
    ...overrides,
  };
}

function authenticatedResult(): SessionResult {
  return { kind: 'authenticated', session: fixtureSession() };
}

beforeEach(() => {
  vi.mocked(listCafeItems).mockReset().mockResolvedValue([]);
  vi.mocked(listBookableOfferings).mockReset().mockResolvedValue([]);
  vi.mocked(listHouseholdMembers).mockReset().mockResolvedValue({ customers: [], children: [] });
  vi.mocked(getSessionResult).mockReset().mockResolvedValue(authenticatedResult());
  vi.mocked(readCart).mockReset().mockResolvedValue({ lines: [] });
});

afterEach(() => {
  cleanup();
});

describe('CartPage', () => {
  // Test 19 — SC-03.
  it('renders a server-recomputed total for a cafe item', async () => {
    vi.mocked(readCart).mockResolvedValue({
      lines: [{ kind: 'CATALOG_ITEM', catalogItemId: CATALOG_ITEM_ID, quantity: 3 }],
    });
    vi.mocked(listCafeItems).mockResolvedValue([cafeItem({ priceCents: 500 })]);

    render(await CartPage());

    expect(screen.getAllByText('$15.00').length).toBeGreaterThanOrEqual(1); // line total (and subtotal)
  });

  // Test 20 — SC-04: the cart's own type makes a price unrepresentable, so
  // this proves the rendered number traces to the mocked catalog lookup, not
  // to anything the (mocked) cookie returned — the shape it returns cannot
  // carry a price at all.
  it('sources every displayed price from the catalog lookup, never the cart', async () => {
    vi.mocked(readCart).mockResolvedValue({
      lines: [{ kind: 'CATALOG_ITEM', catalogItemId: CATALOG_ITEM_ID, quantity: 1 }],
    });
    vi.mocked(listCafeItems).mockResolvedValue([cafeItem({ priceCents: 999 })]);

    render(await CartPage());

    expect(screen.getAllByText('$9.99').length).toBeGreaterThanOrEqual(1);
  });

  // Test 21 — SC-17's review half.
  it('names every selected class participant', async () => {
    vi.mocked(readCart).mockResolvedValue({
      lines: [
        {
          kind: 'OCCURRENCE',
          occurrenceId: OCCURRENCE_ID,
          participants: [
            { kind: 'CUSTOMER', customerId: CUSTOMER_ID },
            { kind: 'CHILD', childId: CHILD_ID },
          ],
        },
      ],
    });
    vi.mocked(listBookableOfferings).mockResolvedValue([occurrence({ seatsRemaining: 8 })]);
    vi.mocked(listHouseholdMembers).mockResolvedValue({
      customers: [fixtureCustomer()],
      children: [fixtureChild()],
    });

    render(await CartPage());

    expect(screen.getByText(/Ada Lovelace/)).toBeInTheDocument();
    expect(screen.getByText(/Grace Hopper/)).toBeInTheDocument();
  });

  // Test 22
  it('renders an archived catalog line as unavailable with a remove control, not omitted', async () => {
    vi.mocked(readCart).mockResolvedValue({
      lines: [{ kind: 'CATALOG_ITEM', catalogItemId: CATALOG_ITEM_ID, quantity: 1 }],
    });
    vi.mocked(listCafeItems).mockResolvedValue([]); // Archived items are excluded from listCafeItems.

    render(await CartPage());

    expect(screen.getByText('This item is no longer available.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /remove/i })).toBeInTheDocument();
  });

  // Test 23
  it('renders a sold-out class line as unavailable with a remove control', async () => {
    vi.mocked(readCart).mockResolvedValue({
      lines: [
        {
          kind: 'OCCURRENCE',
          occurrenceId: OCCURRENCE_ID,
          participants: [{ kind: 'CUSTOMER', customerId: CUSTOMER_ID }],
        },
      ],
    });
    vi.mocked(listBookableOfferings).mockResolvedValue([occurrence({ seatsRemaining: 0 })]);
    vi.mocked(listHouseholdMembers).mockResolvedValue({ customers: [fixtureCustomer()], children: [] });

    render(await CartPage());

    expect(screen.getByText(/sold out/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /remove/i })).toBeInTheDocument();
  });

  // Test 24
  it('labels the subtotal as excluding tax', async () => {
    vi.mocked(readCart).mockResolvedValue({
      lines: [{ kind: 'CATALOG_ITEM', catalogItemId: CATALOG_ITEM_ID, quantity: 1 }],
    });
    vi.mocked(listCafeItems).mockResolvedValue([cafeItem()]);

    render(await CartPage());

    expect(screen.getByText(/tax is calculated at checkout/i)).toBeInTheDocument();
  });

  // WS-13 mounts the checkout control on the review page.
  it('mounts an enabled checkout control when every line is available', async () => {
    vi.mocked(readCart).mockResolvedValue({
      lines: [{ kind: 'CATALOG_ITEM', catalogItemId: CATALOG_ITEM_ID, quantity: 1 }],
    });
    vi.mocked(listCafeItems).mockResolvedValue([cafeItem()]);

    render(await CartPage());

    expect(screen.getByRole('button', { name: /checkout/i })).toBeEnabled();
  });

  // WS-13 Implementation Step 4: disabled when any line resolved as
  // unavailable.
  it('disables the checkout control when a line is unavailable', async () => {
    vi.mocked(readCart).mockResolvedValue({
      lines: [{ kind: 'CATALOG_ITEM', catalogItemId: CATALOG_ITEM_ID, quantity: 1 }],
    });
    vi.mocked(listCafeItems).mockResolvedValue([]); // Archived: renders unavailable.

    render(await CartPage());

    expect(screen.getByRole('button', { name: /checkout/i })).toBeDisabled();
  });

  it('has no checkout control on an empty cart', async () => {
    render(await CartPage());

    expect(screen.queryByRole('button', { name: /checkout/i })).not.toBeInTheDocument();
  });

  it("imports no order-creating action from any of this workstream's modules", () => {
    // Matches an actual call or import, not commerce-core doc comments that
    // merely name createOrder/startCheckout as the authoritative boundary
    // WS-09's own validation defers to.
    const moduleFiles = ['cart-cookie.ts', 'cart-shape.ts', 'actions.ts', 'resolve-cart.ts', 'page.tsx', 'remove-line-button.tsx'];
    for (const fileName of moduleFiles) {
      const source = readFileSync(join(dir, fileName), 'utf-8');
      expect(source).not.toMatch(/\bcreateOrder\(/);
      expect(source).not.toMatch(/\bstartCheckout\(/);
      expect(source).not.toMatch(/@keki\/square-client/);
    }
  });

  it('renders an empty cart without crashing', async () => {
    render(await CartPage());

    expect(screen.getByText(/cart is empty/i)).toBeInTheDocument();
  });
});
