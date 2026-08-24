// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { URL as NodeURL, fileURLToPath } from 'node:url';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionResult } from '@keki/auth';
import { createCustomerId } from '@keki/contracts';

const { mockCompleteProfileAction, mockGetSessionResult, mockRedirect } = vi.hoisted(() => ({
  mockCompleteProfileAction: vi.fn(),
  mockGetSessionResult: vi.fn(),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock('../require-session', () => ({ getSessionResult: mockGetSessionResult }));
vi.mock('next/navigation', () => ({ redirect: mockRedirect }));
vi.mock('./complete-profile-action', () => ({ completeProfileAction: mockCompleteProfileAction }));

import CompleteProfilePage from './page';

function unprovisioned(overrides: Partial<Extract<SessionResult, { kind: 'unprovisioned' }>> = {}): SessionResult {
  return {
    kind: 'unprovisioned',
    cognitoSub: 'cognito-sub-1',
    email: 'ada@example.com',
    givenName: 'Ada',
    familyName: 'Lovelace',
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

afterEach(() => {
  cleanup();
});

describe('CompleteProfilePage', () => {
  beforeEach(() => {
    mockCompleteProfileAction.mockReset();
    mockGetSessionResult.mockReset();
    mockRedirect.mockClear();
  });

  // Test 1 — SC-08
  it('renders the form for an unprovisioned session', async () => {
    mockGetSessionResult.mockResolvedValue(unprovisioned());

    render(await CompleteProfilePage());

    expect(screen.getByLabelText('First name')).toBeInTheDocument();
    expect(screen.getByLabelText('Last name')).toBeInTheDocument();
  });

  // Test 2
  it('redirects an anonymous session to sign-in', async () => {
    mockGetSessionResult.mockResolvedValue({ kind: 'anonymous' });

    await expect(CompleteProfilePage()).rejects.toThrow('REDIRECT:/auth/sign-in');
  });

  // Test 3
  it('redirects an authenticated session to /book rather than rendering the form', async () => {
    const authenticatedResult: SessionResult = {
      kind: 'authenticated',
      session: {
        cognitoSub: 'cognito-sub-1',
        profile: {
          customerId: createCustomerId('11111111-1111-4111-8111-111111111111'),
          householdId: null,
          email: 'ada@example.com',
          firstName: 'Ada',
          lastName: 'Lovelace',
          role: 'CUSTOMER',
        },
      },
    };
    mockGetSessionResult.mockResolvedValue(authenticatedResult);

    await expect(CompleteProfilePage()).rejects.toThrow('REDIRECT:/book');
  });

  // Test 4
  it('does not import requireRole, which would loop against its own guard', () => {
    const filePath = fileURLToPath(new NodeURL('./page.tsx', import.meta.url));
    const source = readFileSync(filePath, 'utf-8');

    expect(source).not.toContain('requireRole');
  });

  // Test 5
  it('renders the email as read-only text, not an editable control', async () => {
    mockGetSessionResult.mockResolvedValue(unprovisioned({ email: 'ada@example.com' }));

    render(await CompleteProfilePage());

    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('ada@example.com')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument();
  });

  // Test 6
  it('pre-fills the name fields from the token claims', async () => {
    mockGetSessionResult.mockResolvedValue(unprovisioned({ givenName: 'Ada', familyName: 'Lovelace' }));

    render(await CompleteProfilePage());

    expect(screen.getByLabelText('First name')).toHaveValue('Ada');
    expect(screen.getByLabelText('Last name')).toHaveValue('Lovelace');
  });

  // Test 7
  it('leaves the name fields empty, not undefined, when claims are missing', async () => {
    mockGetSessionResult.mockResolvedValue(unprovisioned({ givenName: undefined, familyName: undefined }));

    render(await CompleteProfilePage());

    expect(screen.getByLabelText('First name')).toHaveValue('');
    expect(screen.getByLabelText('Last name')).toHaveValue('');
  });

  // Test 8
  it('submits the action with the parsed names', async () => {
    mockGetSessionResult.mockResolvedValue(unprovisioned({ givenName: 'Ada', familyName: 'Lovelace' }));
    mockCompleteProfileAction.mockResolvedValue({ ok: true, data: undefined });

    render(await CompleteProfilePage());

    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Grace' } });
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Hopper' } });
    fireEvent.click(screen.getByRole('button', { name: 'Complete profile' }));

    await waitFor(() => expect(mockCompleteProfileAction).toHaveBeenCalledOnce());
    expect(mockCompleteProfileAction).toHaveBeenCalledWith({ firstName: 'Grace', lastName: 'Hopper' });
  });

  // Test 19
  it('disables the submit control while pending, so a double-click cannot double-submit', async () => {
    mockGetSessionResult.mockResolvedValue(unprovisioned());
    const deferred = createDeferred<{ ok: true; data: undefined }>();
    mockCompleteProfileAction.mockReturnValue(deferred.promise);

    render(await CompleteProfilePage());

    fireEvent.click(screen.getByRole('button', { name: 'Complete profile' }));

    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();

    deferred.resolve({ ok: true, data: undefined });
    await waitFor(() => expect(mockCompleteProfileAction).toHaveBeenCalledOnce());
  });

  // Test 20
  it('renders the message from a failed submission', async () => {
    mockGetSessionResult.mockResolvedValue(unprovisioned());
    mockCompleteProfileAction.mockResolvedValue({
      ok: false,
      error: { code: 'VALIDATION', message: 'First name is required.' },
    });

    render(await CompleteProfilePage());

    fireEvent.click(screen.getByRole('button', { name: 'Complete profile' }));

    expect(await screen.findByText('First name is required.')).toBeInTheDocument();
  });
});
