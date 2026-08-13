import type { Session, SessionResult } from '@keki/auth';
import { createCustomerId, type Role } from '@keki/contracts';
import { z } from 'zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockAuthorize, mockGetSessionResult, mockRedirect } = vi.hoisted(() => ({
  mockAuthorize: vi.fn(),
  mockGetSessionResult: vi.fn(),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock('@keki/auth', () => ({ authorize: mockAuthorize }));
vi.mock('../auth/require-session', () => ({ getSessionResult: mockGetSessionResult }));
vi.mock('next/navigation', () => ({ redirect: mockRedirect }));

import { authenticatedAction } from './authenticated-action';

const FIXTURE_CUSTOMER_ID = createCustomerId('11111111-1111-4111-8111-111111111111');

function fixtureSession(role: Role = 'CUSTOMER'): Session {
  return {
    cognitoSub: 'cognito-sub-1',
    profile: {
      customerId: FIXTURE_CUSTOMER_ID,
      householdId: null,
      email: 'person@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
      role,
    },
  };
}

const authenticatedResult: SessionResult = { kind: 'authenticated', session: fixtureSession() };
const schema = z.object({ name: z.string().min(1) });

describe('authenticatedAction', () => {
  beforeEach(() => {
    mockAuthorize.mockReset();
    mockGetSessionResult.mockReset();
    mockGetSessionResult.mockResolvedValue(authenticatedResult);
    mockRedirect.mockClear();
  });

  // Test 1 — SC-14
  it('rejects an anonymous caller with UNAUTHENTICATED', async () => {
    mockAuthorize.mockReturnValue({ allowed: false, reason: 'anonymous' });
    const handler = vi.fn();
    const action = authenticatedAction({ schema, handler });

    const result = await action({ name: 'Ada' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNAUTHENTICATED');
    }
  });

  // Test 2
  it('distinguishes an unprovisioned caller with UNPROVISIONED', async () => {
    mockAuthorize.mockReturnValue({ allowed: false, reason: 'unprovisioned' });
    const handler = vi.fn();
    const action = authenticatedAction({ schema, handler });

    const result = await action({ name: 'Ada' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNPROVISIONED');
    }
  });

  // Test 3
  it('rejects an insufficient role with FORBIDDEN', async () => {
    mockAuthorize.mockReturnValue({ allowed: false, reason: 'insufficient_role' });
    const handler = vi.fn();
    const action = authenticatedAction({ schema, handler, requiredRole: 'MANAGER' });

    const result = await action({ name: 'Ada' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FORBIDDEN');
    }
  });

  // Test 4
  it('authorizes before parsing input, so an anonymous caller with invalid input still gets UNAUTHENTICATED', async () => {
    mockAuthorize.mockReturnValue({ allowed: false, reason: 'anonymous' });
    const handler = vi.fn();
    const action = authenticatedAction({ schema, handler });

    const result = await action({ name: '' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNAUTHENTICATED');
    }
  });

  // Test 5
  it('never runs the handler when unauthorized', async () => {
    mockAuthorize.mockReturnValue({ allowed: false, reason: 'anonymous' });
    const handler = vi.fn();
    const action = authenticatedAction({ schema, handler });

    await action({ name: 'Ada' });

    expect(handler).not.toHaveBeenCalled();
  });

  // Test 6
  it('delegates the allow/deny decision to authorize, never comparing roles locally', async () => {
    mockAuthorize.mockReturnValue({ allowed: true, session: fixtureSession('MANAGER') });
    const handler = vi.fn().mockResolvedValue('ok');
    const action = authenticatedAction({ schema, handler, requiredRole: 'MANAGER' });

    await action({ name: 'Ada' });

    expect(mockAuthorize).toHaveBeenCalledWith({
      result: authenticatedResult,
      requiredRole: 'MANAGER',
    });
  });

  // Test 7
  it('defaults the required role to CUSTOMER', async () => {
    mockAuthorize.mockReturnValue({ allowed: false, reason: 'anonymous' });
    const handler = vi.fn();
    const action = authenticatedAction({ schema, handler });

    await action({ name: 'Ada' });

    expect(mockAuthorize).toHaveBeenCalledWith(expect.objectContaining({ requiredRole: 'CUSTOMER' }));
  });

  // Test 8
  it('passes parsed input and the resolved session to the handler', async () => {
    const session = fixtureSession();
    mockAuthorize.mockReturnValue({ allowed: true, session });
    const handler = vi.fn().mockResolvedValue({ id: 1 });
    const action = authenticatedAction({ schema, handler });

    await action({ name: 'Ada' });

    expect(handler).toHaveBeenCalledWith({ name: 'Ada' }, session);
  });

  // Test 9
  it('returns VALIDATION with field errors for invalid input', async () => {
    mockAuthorize.mockReturnValue({ allowed: true, session: fixtureSession() });
    const handler = vi.fn();
    const action = authenticatedAction({ schema, handler });

    const result = await action({ name: '' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
      expect(result.error.fieldErrors?.name).toBeDefined();
    }
    expect(handler).not.toHaveBeenCalled();
  });

  // Test 10
  it('never calls redirect', async () => {
    mockAuthorize.mockReturnValue({ allowed: false, reason: 'anonymous' });
    const handler = vi.fn();
    const action = authenticatedAction({ schema, handler });

    await action({ name: 'Ada' });

    expect(mockRedirect).not.toHaveBeenCalled();

    mockAuthorize.mockReturnValue({ allowed: true, session: fixtureSession() });
    await action({ name: 'Ada' });

    expect(mockRedirect).not.toHaveBeenCalled();
  });

  // Test 14
  it('returns ok: true with data on success', async () => {
    mockAuthorize.mockReturnValue({ allowed: true, session: fixtureSession() });
    const handler = vi.fn().mockResolvedValue({ id: 1 });
    const action = authenticatedAction({ schema, handler });

    const result = await action({ name: 'Ada' });

    expect(result).toEqual({ ok: true, data: { id: 1 } });
  });
});
