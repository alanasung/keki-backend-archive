import { createCustomerId, ROLES, type Role } from '@keki/contracts';
import type { Session, SessionResult } from '@keki/auth';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const dir = dirname(fileURLToPath(import.meta.url));

const { mockGetSessionResult, mockHeadersGet, mockCookiesGet, mockRedirect } = vi.hoisted(() => ({
  mockGetSessionResult: vi.fn(),
  mockHeadersGet: vi.fn(),
  mockCookiesGet: vi.fn(),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock('./require-session', () => ({ getSessionResult: mockGetSessionResult }));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve({ get: mockHeadersGet })),
  cookies: vi.fn(() => Promise.resolve({ get: mockCookiesGet })),
}));

vi.mock('next/navigation', () => ({ redirect: mockRedirect }));

import { requireKioskDevice, requireRole, sanitizeNextPath } from './guards';

const FIXTURE_CUSTOMER_ID = createCustomerId('11111111-1111-4111-8111-111111111111');

function authenticated(role: Role): Extract<SessionResult, { kind: 'authenticated' }> {
  const session: Session = {
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
  return { kind: 'authenticated', session };
}

const anonymous: SessionResult = { kind: 'anonymous' };
const unprovisioned: SessionResult = { kind: 'unprovisioned', cognitoSub: 'cognito-sub-2' };

function redirectTargetOf(url: string): string {
  return `REDIRECT:${url}`;
}

describe('requireRole', () => {
  beforeEach(() => {
    mockGetSessionResult.mockReset();
    mockHeadersGet.mockReset();
    mockRedirect.mockClear();
  });

  // Case 1
  it('redirects an anonymous staff request to sign-in with a next param', async () => {
    mockGetSessionResult.mockResolvedValue(anonymous);
    mockHeadersGet.mockReturnValue('/staff/today');

    await expect(requireRole('FRONT_OF_HOUSE')).rejects.toThrow(
      redirectTargetOf('/auth/sign-in?next=%2Fstaff%2Ftoday'),
    );
  });

  // Case 2
  it('redirects an anonymous admin request to sign-in with a next param', async () => {
    mockGetSessionResult.mockResolvedValue(anonymous);
    mockHeadersGet.mockReturnValue('/admin/offerings');

    await expect(requireRole('MANAGER')).rejects.toThrow(
      redirectTargetOf('/auth/sign-in?next=%2Fadmin%2Fofferings'),
    );
  });

  // Case 3
  it('sends an unprovisioned session to complete-profile, not sign-in', async () => {
    mockGetSessionResult.mockResolvedValue(unprovisioned);

    await expect(requireRole('CUSTOMER')).rejects.toThrow(redirectTargetOf('/auth/complete-profile'));
    expect(mockRedirect).not.toHaveBeenCalledWith(expect.stringContaining('/auth/sign-in'));
  });

  // Case 4
  it('sends an insufficient role to unauthorized, not sign-in', async () => {
    mockGetSessionResult.mockResolvedValue(authenticated('CUSTOMER'));

    await expect(requireRole('MANAGER')).rejects.toThrow(redirectTargetOf('/auth/unauthorized'));
    expect(mockRedirect).not.toHaveBeenCalledWith(expect.stringContaining('/auth/sign-in'));
  });

  // Case 5
  it('allows a sufficient role without redirecting', async () => {
    const result = authenticated('MANAGER');
    mockGetSessionResult.mockResolvedValue(result);

    const session = await requireRole('MANAGER');

    expect(session).toEqual(result.session);
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  // Case 6
  it('lets a higher role pass a lower gate', async () => {
    mockGetSessionResult.mockResolvedValue(authenticated('ADMIN'));

    await expect(requireRole('FRONT_OF_HOUSE')).resolves.toBeDefined();
    await expect(requireRole('CUSTOMER')).resolves.toBeDefined();
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  // Case 7
  it('fails a lower role against a higher gate', async () => {
    mockGetSessionResult.mockResolvedValue(authenticated('FRONT_OF_HOUSE'));

    await expect(requireRole('ADMIN')).rejects.toThrow(redirectTargetOf('/auth/unauthorized'));
  });

  // Case 8
  it('does not compare role strings or reimplement the hierarchy', () => {
    const source = readFileSync(join(dir, 'guards.ts'), 'utf-8');
    for (const role of ROLES) {
      expect(source).not.toContain(`'${role}'`);
      expect(source).not.toContain(`"${role}"`);
    }
    expect(source).not.toMatch(/ROLE_RANK/);
  });
});

describe('sanitizeNextPath', () => {
  // Case 17
  it('accepts a same-origin relative path', () => {
    expect(sanitizeNextPath('/staff/today')).toBe('/staff/today');
  });

  it.each(['//evil.example', 'https://evil.example', '/\\evil.example'])(
    'rejects %s and falls back to the default path',
    (input) => {
      expect(sanitizeNextPath(input)).toBe('/');
    },
  );

  it('falls back to the default path when absent', () => {
    expect(sanitizeNextPath(undefined)).toBe('/');
    expect(sanitizeNextPath(null)).toBe('/');
  });
});

describe('requireKioskDevice', () => {
  const originalEnv = process.env.KIOSK_DEVICE_TOKEN;

  beforeEach(() => {
    mockCookiesGet.mockReset();
    mockRedirect.mockClear();
    process.env.KIOSK_DEVICE_TOKEN = 'device-secret';
  });

  afterAll(() => {
    if (originalEnv === undefined) {
      delete process.env.KIOSK_DEVICE_TOKEN;
    } else {
      process.env.KIOSK_DEVICE_TOKEN = originalEnv;
    }
  });

  it('redirects to sign-in when the device cookie is absent', async () => {
    mockCookiesGet.mockReturnValue(undefined);

    await expect(requireKioskDevice()).rejects.toThrow(redirectTargetOf('/auth/sign-in'));
  });

  it('redirects to sign-in when the device cookie does not match', async () => {
    mockCookiesGet.mockReturnValue({ value: 'wrong-token' });

    await expect(requireKioskDevice()).rejects.toThrow(redirectTargetOf('/auth/sign-in'));
  });

  it('allows the request through when the device cookie matches', async () => {
    mockCookiesGet.mockReturnValue({ value: 'device-secret' });

    await expect(requireKioskDevice()).resolves.toBeUndefined();
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});
