// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { URL as NodeURL, fileURLToPath } from 'node:url';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@keki/auth';
import {
  createChildId,
  createCustomerId,
  createHouseholdId,
  type Child,
  type Customer,
  type Order,
} from '@keki/contracts';

const FIXTURE_HOUSEHOLD_ID = createHouseholdId('11111111-1111-4111-8111-111111111111');
const FIXTURE_CUSTOMER_ID = createCustomerId('22222222-2222-4222-8222-222222222222');

const {
  mockAddChildAction,
  mockGetHouseholdName,
  mockListHouseholdMembers,
  mockListOrdersForHousehold,
  mockRequireRole,
  mockUpdateHouseholdNameAction,
} = vi.hoisted(() => ({
  mockAddChildAction: vi.fn(),
  mockGetHouseholdName: vi.fn(),
  mockListHouseholdMembers: vi.fn(),
  mockListOrdersForHousehold: vi.fn(),
  mockRequireRole: vi.fn(),
  mockUpdateHouseholdNameAction: vi.fn(),
}));

vi.mock('../../auth/guards', () => ({ requireRole: mockRequireRole }));
vi.mock('@keki/commerce-core', () => ({ listOrdersForHousehold: mockListOrdersForHousehold }));
vi.mock('@keki/customer-core', () => ({
  getHouseholdName: mockGetHouseholdName,
  listHouseholdMembers: mockListHouseholdMembers,
}));
vi.mock('./account-actions', () => ({
  addChildAction: mockAddChildAction,
  updateHouseholdNameAction: mockUpdateHouseholdNameAction,
}));

import AccountPage from './page';

function fixtureSession(): Session {
  return {
    cognitoSub: 'cognito-sub-1',
    profile: {
      customerId: FIXTURE_CUSTOMER_ID,
      householdId: FIXTURE_HOUSEHOLD_ID,
      email: 'ada@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
      role: 'CUSTOMER',
    },
  };
}

function fixtureCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: FIXTURE_CUSTOMER_ID,
    householdId: FIXTURE_HOUSEHOLD_ID,
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
    id: createChildId('33333333-3333-4333-8333-333333333333'),
    householdId: FIXTURE_HOUSEHOLD_ID,
    firstName: 'Grace',
    lastName: 'Lovelace',
    dateOfBirth: new Date('2019-03-04'),
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

function todayDateString(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const NO_ORDERS: readonly Order[] = [];

afterEach(() => {
  cleanup();
});

describe('AccountPage', () => {
  beforeEach(() => {
    mockAddChildAction.mockReset();
    mockGetHouseholdName.mockReset();
    mockGetHouseholdName.mockResolvedValue('Lovelace Household');
    mockListHouseholdMembers.mockReset();
    mockListHouseholdMembers.mockResolvedValue({ customers: [fixtureCustomer()], children: [fixtureChild()] });
    mockListOrdersForHousehold.mockReset();
    mockListOrdersForHousehold.mockResolvedValue(NO_ORDERS);
    mockRequireRole.mockReset();
    mockRequireRole.mockResolvedValue(fixtureSession());
    mockUpdateHouseholdNameAction.mockReset();
  });

  // Test 1
  it('renders the add-child form with its three fields', async () => {
    render(await AccountPage());

    expect(screen.getByLabelText('First name')).toBeInTheDocument();
    expect(screen.getByLabelText('Last name')).toBeInTheDocument();
    expect(screen.getByLabelText('Date of birth')).toBeInTheDocument();
  });

  // Test 2
  it('renders the date of birth field as type="date"', async () => {
    render(await AccountPage());

    expect(screen.getByLabelText('Date of birth')).toHaveAttribute('type', 'date');
  });

  // Test 3
  it("caps the date of birth field's max at today", async () => {
    render(await AccountPage());

    expect(screen.getByLabelText('Date of birth')).toHaveAttribute('max', todayDateString());
  });

  // Test 4 & 5 — SC-12
  it('submits the add-child action with the parsed values and no householdId', async () => {
    mockAddChildAction.mockResolvedValue({ ok: true, data: undefined });
    render(await AccountPage());

    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Grace' } });
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Lovelace' } });
    fireEvent.change(screen.getByLabelText('Date of birth'), { target: { value: '2019-03-04' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add child' }));

    await waitFor(() => expect(mockAddChildAction).toHaveBeenCalledOnce());
    const payload = mockAddChildAction.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).toEqual({ firstName: 'Grace', lastName: 'Lovelace', dateOfBirth: '2019-03-04' });
    expect(Object.keys(payload)).not.toContain('householdId');
  });

  // Test 10
  it('clears the add-child form on a successful submission', async () => {
    mockAddChildAction.mockResolvedValue({ ok: true, data: undefined });
    render(await AccountPage());

    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Grace' } });
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Lovelace' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add child' }));

    await waitFor(() => expect(mockAddChildAction).toHaveBeenCalledOnce());
    expect(screen.getByLabelText('First name')).toHaveValue('');
    expect(screen.getByLabelText('Last name')).toHaveValue('');
  });

  // Test 11
  it('disables the add-child submit control while pending', async () => {
    const deferred = createDeferred<{ ok: true; data: undefined }>();
    mockAddChildAction.mockReturnValue(deferred.promise);
    render(await AccountPage());

    fireEvent.click(screen.getByRole('button', { name: 'Add child' }));

    expect(screen.getByRole('button', { name: 'Adding…' })).toBeDisabled();

    deferred.resolve({ ok: true, data: undefined });
    await waitFor(() => expect(mockAddChildAction).toHaveBeenCalledOnce());
  });

  // Test 12
  it('renders the message from a failed add-child submission', async () => {
    mockAddChildAction.mockResolvedValue({
      ok: false,
      error: { code: 'VALIDATION', message: 'Date of birth cannot be in the future.' },
    });
    render(await AccountPage());

    fireEvent.click(screen.getByRole('button', { name: 'Add child' }));

    expect(await screen.findByText('Date of birth cannot be in the future.')).toBeInTheDocument();
  });

  // Test 15
  it('renders existing children by name', async () => {
    mockListHouseholdMembers.mockResolvedValue({
      customers: [fixtureCustomer()],
      children: [
        fixtureChild({ id: createChildId('33333333-3333-4333-8333-333333333333'), firstName: 'Grace' }),
        fixtureChild({ id: createChildId('44444444-4444-4444-8444-444444444444'), firstName: 'Ada Jr' }),
      ],
    });

    render(await AccountPage());

    expect(screen.getByText(/Grace Lovelace/)).toBeInTheDocument();
    expect(screen.getByText(/Ada Jr Lovelace/)).toBeInTheDocument();
  });

  // Test 16
  it('renders guidance to add a child, not an empty list, when the household has none', async () => {
    mockListHouseholdMembers.mockResolvedValue({ customers: [fixtureCustomer()], children: [] });

    render(await AccountPage());

    expect(screen.getByText(/Adding a child is how you book a class for them/)).toBeInTheDocument();
  });

  // Test 17
  it('pre-fills the household rename field with the current name', async () => {
    mockGetHouseholdName.mockResolvedValue('Lovelace Household');

    render(await AccountPage());

    expect(screen.getByLabelText('Household name')).toHaveValue('Lovelace Household');
  });

  // Test 18 & 19 — SC-12
  it('renames with the entered name and sends no householdId', async () => {
    mockUpdateHouseholdNameAction.mockResolvedValue({ ok: true, data: undefined });
    render(await AccountPage());

    fireEvent.change(screen.getByLabelText('Household name'), { target: { value: 'The Lovelaces' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockUpdateHouseholdNameAction).toHaveBeenCalledOnce());
    const payload = mockUpdateHouseholdNameAction.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).toEqual({ name: 'The Lovelaces' });
    expect(Object.keys(payload)).not.toContain('householdId');
  });

  // Test 20
  it('shows a confirmation after a successful rename', async () => {
    mockUpdateHouseholdNameAction.mockResolvedValue({ ok: true, data: undefined });
    render(await AccountPage());

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Household name updated.')).toBeInTheDocument();
  });

  // Test 22
  it('renders no child edit or delete control', async () => {
    render(await AccountPage());

    expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /remove/i })).not.toBeInTheDocument();
  });

  // Test 23
  it("no longer describes addChild or updateHousehold as NotImplementedInPhase1 stubs", () => {
    const filePath = fileURLToPath(new NodeURL('./page.tsx', import.meta.url));
    const source = readFileSync(filePath, 'utf-8');

    expect(source).not.toMatch(/addChild/);
    expect(source).not.toMatch(/updateHousehold/);
  });

});
