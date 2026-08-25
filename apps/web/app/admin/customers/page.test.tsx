// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Child, Customer, CustomerId, HouseholdId, Order } from '@keki/contracts';
import {
  createChildId,
  createCustomerId,
  createHouseholdId,
  createOrderId,
} from '@keki/contracts';

const currentDir = dirname(fileURLToPath(import.meta.url));

const { mockSearchCustomers, mockGetHouseholdName, mockListHouseholdMembers, mockListOrdersForHousehold, mockNotFound } =
  vi.hoisted(() => ({
    mockSearchCustomers: vi.fn(),
    mockGetHouseholdName: vi.fn(),
    mockListHouseholdMembers: vi.fn(),
    mockListOrdersForHousehold: vi.fn(),
    mockNotFound: vi.fn(() => {
      throw new Error('NEXT_NOT_FOUND');
    }),
  }));

vi.mock('@keki/customer-core', () => ({
  searchCustomers: mockSearchCustomers,
  getHouseholdName: mockGetHouseholdName,
  listHouseholdMembers: mockListHouseholdMembers,
}));
vi.mock('@keki/commerce-core', () => ({ listOrdersForHousehold: mockListOrdersForHousehold }));
vi.mock('next/navigation', () => ({ notFound: mockNotFound }));

import AdminCustomersPage from './page';

const HOUSEHOLD_ID = createHouseholdId('11111111-1111-4111-8111-111111111111');
const CUSTOMER_ID = createCustomerId('22222222-2222-4222-8222-222222222222');
const OTHER_CUSTOMER_ID = createCustomerId('33333333-3333-4333-8333-333333333333');
const CHILD_ID = createChildId('44444444-4444-4444-8444-444444444444');
const ORDER_ID = createOrderId('55555555-5555-4555-8555-555555555555');
const OTHER_ORDER_ID = createOrderId('66666666-6666-4666-8666-666666666666');

function customerFixture(overrides: Partial<Customer> = {}): Customer {
  return {
    id: CUSTOMER_ID,
    householdId: HOUSEHOLD_ID,
    cognitoSub: 'cognito-sub-1',
    email: 'ada@example.test',
    firstName: 'Ada',
    lastName: 'Lovelace',
    phone: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function childFixture(overrides: Partial<Child> = {}): Child {
  return {
    id: CHILD_ID,
    householdId: HOUSEHOLD_ID,
    firstName: 'Grace',
    lastName: 'Hopper',
    dateOfBirth: new Date('2018-05-01'),
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function orderFixture(overrides: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    householdId: HOUSEHOLD_ID,
    createdByCustomerId: CUSTOMER_ID,
    status: 'PAID',
    subtotalCents: 2500,
    currency: 'USD',
    squareOrderId: null,
    squareCheckoutUrl: null,
    providerPaymentId: null,
    expiresAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

interface CustomerSearchResultFixture {
  readonly customerId: CustomerId;
  readonly householdId: HouseholdId;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
}

function searchResultFixture(overrides: Partial<CustomerSearchResultFixture> = {}): CustomerSearchResultFixture {
  return {
    customerId: CUSTOMER_ID,
    householdId: HOUSEHOLD_ID,
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.test',
    ...overrides,
  };
}

async function renderPage(query: { q?: string; householdId?: string } = {}) {
  return render(await AdminCustomersPage({ searchParams: Promise.resolve(query) }));
}

beforeEach(() => {
  mockSearchCustomers.mockReset().mockResolvedValue([]);
  mockGetHouseholdName.mockReset().mockResolvedValue('Lovelace Household');
  mockListHouseholdMembers.mockReset().mockResolvedValue({ customers: [customerFixture()], children: [childFixture()] });
  mockListOrdersForHousehold.mockReset().mockResolvedValue([]);
  mockNotFound.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('AdminCustomersPage', () => {
  // Test 10
  it('renders a search form', async () => {
    await renderPage();

    expect(screen.getByRole('searchbox', { name: /search customers/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /search/i })).toBeInTheDocument();
  });

  // Test 11
  it('submits the search as a GET to the same route', async () => {
    await renderPage();

    const form = screen.getByRole('searchbox', { name: /search customers/i }).closest('form');
    expect(form).not.toBeNull();
    expect(form?.getAttribute('method')).toBe('get');
    expect(form?.getAttribute('action')).toBe('/admin/customers');
  });

  // Test 12
  it('renders search result name and email', async () => {
    mockSearchCustomers.mockResolvedValue([
      searchResultFixture({ customerId: CUSTOMER_ID, firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test' }),
      searchResultFixture({
        customerId: OTHER_CUSTOMER_ID,
        firstName: 'Grace',
        lastName: 'Hopper',
        email: 'grace@example.test',
      }),
    ]);

    await renderPage({ q: 'ada' });

    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('ada@example.test')).toBeInTheDocument();
    expect(screen.getByText('Grace Hopper')).toBeInTheDocument();
    expect(screen.getByText('grace@example.test')).toBeInTheDocument();
  });

  // Test 13
  it('says a search had no matches, naming the term', async () => {
    mockSearchCustomers.mockResolvedValue([]);

    await renderPage({ q: 'nobody-such' });

    expect(screen.getByText(/no customers matched/i)).toBeInTheDocument();
    expect(screen.getByText(/nobody-such/)).toBeInTheDocument();
  });

  // Test 14
  it('renders an invitation, not an error, when no search has run yet', async () => {
    await renderPage();

    expect(screen.getByText(/search for a customer/i)).toBeInTheDocument();
    expect(mockSearchCustomers).not.toHaveBeenCalled();
  });

  // Test 15
  it("renders a selected household's members", async () => {
    mockListHouseholdMembers.mockResolvedValue({
      customers: [customerFixture({ firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test' })],
      children: [],
    });

    await renderPage({ householdId: HOUSEHOLD_ID });

    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('ada@example.test')).toBeInTheDocument();
  });

  // Test 16
  it('renders children with dates of birth, not a computed age', async () => {
    mockListHouseholdMembers.mockResolvedValue({
      customers: [],
      children: [childFixture({ dateOfBirth: new Date('2018-05-01') })],
    });

    await renderPage({ householdId: HOUSEHOLD_ID });

    expect(screen.getByText(/May 1, 2018/)).toBeInTheDocument();
  });

  // Test 17
  it('says a household has no children rather than rendering an empty list', async () => {
    mockListHouseholdMembers.mockResolvedValue({ customers: [customerFixture()], children: [] });

    await renderPage({ householdId: HOUSEHOLD_ID });

    expect(screen.getByText('No children')).toBeInTheDocument();
  });

  // Test 18
  it('renders recent orders with status and total', async () => {
    mockListOrdersForHousehold.mockResolvedValue([
      orderFixture({ id: ORDER_ID, status: 'PAID', subtotalCents: 2500, currency: 'USD' }),
      orderFixture({ id: OTHER_ORDER_ID, status: 'CANCELLED', subtotalCents: 1000, currency: 'USD' }),
    ]);

    await renderPage({ householdId: HOUSEHOLD_ID });

    expect(screen.getByText('Confirmed')).toBeInTheDocument();
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
    expect(screen.getByText('$25.00')).toBeInTheDocument();
    expect(screen.getByText('$10.00')).toBeInTheDocument();
  });

  // Test 19
  it('says a household has no orders', async () => {
    mockListOrdersForHousehold.mockResolvedValue([]);

    await renderPage({ householdId: HOUSEHOLD_ID });

    expect(screen.getByText(/no orders/i)).toBeInTheDocument();
  });

  // Test 20 — Phase 3 shipped eleven blank rows this way; the regression guard.
  it('never renders a member row as blank', async () => {
    mockListHouseholdMembers.mockResolvedValue({
      customers: [customerFixture({ firstName: 'Ada', lastName: '' })],
      children: [],
    });

    await renderPage({ householdId: HOUSEHOLD_ID });

    expect(screen.getByText(/Ada/)).toBeInTheDocument();
  });

  // Test 21
  it('renders not-found for an unknown household id rather than crashing', async () => {
    mockGetHouseholdName.mockResolvedValue(null);

    await expect(renderPage({ householdId: HOUSEHOLD_ID })).rejects.toThrow();

    expect(mockNotFound).toHaveBeenCalledTimes(1);
  });

  it('renders not-found for a malformed household id', async () => {
    await expect(renderPage({ householdId: 'not-a-uuid' })).rejects.toThrow();

    expect(mockNotFound).toHaveBeenCalledTimes(1);
    expect(mockGetHouseholdName).not.toHaveBeenCalled();
  });

  // Test 22
  it('renders the household named in searchParams', async () => {
    mockGetHouseholdName.mockResolvedValue('Lovelace Household');

    await renderPage({ householdId: HOUSEHOLD_ID });

    expect(mockGetHouseholdName).toHaveBeenCalledWith(HOUSEHOLD_ID);
    expect(screen.getByText('Lovelace Household')).toBeInTheDocument();
  });

  // Test 23
  it('renders no mutation control of any kind', async () => {
    mockSearchCustomers.mockResolvedValue([searchResultFixture()]);

    await renderPage({ q: 'ada', householdId: HOUSEHOLD_ID });

    expect(screen.queryByRole('link', { name: /^edit$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /add.?child/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /delete/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add.?child/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
  });

  // Test 24
  it('adds no role guard of its own', () => {
    const source = readFileSync(join(currentDir, 'page.tsx'), 'utf-8');

    expect(source).not.toMatch(/requireRole/);
  });
});
