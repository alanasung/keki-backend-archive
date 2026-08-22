import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Session, SessionResult } from '@keki/auth';
import { createCustomerId, createOfferingId, type Offering, type Role } from '@keki/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAuthorize,
  mockGetSessionResult,
  mockRevalidatePath,
  mockCreateOffering,
  mockUpdateOffering,
  mockTransitionOffering,
} = vi.hoisted(() => ({
  mockAuthorize: vi.fn(),
  mockGetSessionResult: vi.fn(),
  mockRevalidatePath: vi.fn(),
  mockCreateOffering: vi.fn(),
  mockUpdateOffering: vi.fn(),
  mockTransitionOffering: vi.fn(),
}));

vi.mock('@keki/auth', () => ({ authorize: mockAuthorize }));
vi.mock('../../auth/require-session', () => ({ getSessionResult: mockGetSessionResult }));
vi.mock('next/cache', () => ({ revalidatePath: mockRevalidatePath }));
vi.mock('@keki/catalog-admin', async () => {
  const actual = await vi.importActual<typeof import('@keki/catalog-admin')>('@keki/catalog-admin');
  return {
    ...actual,
    createOffering: mockCreateOffering,
    updateOffering: mockUpdateOffering,
    transitionOffering: mockTransitionOffering,
  };
});

import { InvalidOfferingTransitionError, OfferingNotFoundError, UnsupportedOfferingTypeError } from '@keki/catalog-admin';
import type { ActionResult } from '../../actions/action-result';
import {
  archiveOfferingAction,
  createOfferingAction,
  publishOfferingAction,
  unpublishOfferingAction,
  updateOfferingAction,
} from './offering-actions';

const FIXTURE_CUSTOMER_ID = createCustomerId('11111111-1111-4111-8111-111111111111');
const OTHER_CUSTOMER_ID = createCustomerId('99999999-9999-4999-8999-999999999999');
const FIXTURE_OFFERING_ID = createOfferingId('22222222-2222-4222-8222-222222222222');

function fixtureSession(role: Role): Session {
  return {
    cognitoSub: 'cognito-sub-1',
    profile: {
      customerId: FIXTURE_CUSTOMER_ID,
      householdId: null,
      email: 'manager@example.com',
      firstName: 'Morgan',
      lastName: 'Manager',
      role,
    },
  };
}

const authenticatedResult: SessionResult = { kind: 'authenticated', session: fixtureSession('MANAGER') };

const FIXTURE_OFFERING: Offering = {
  id: FIXTURE_OFFERING_ID,
  slug: 'yoga-101',
  type: 'CLASS',
  status: 'DRAFT',
  name: 'Yoga 101',
  description: null,
  durationMinutes: 60,
  defaultCapacity: 10,
  priceCents: 2000,
  currency: 'USD',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

const CREATE_PAYLOAD = {
  name: 'Yoga 101',
  description: null,
  type: 'CLASS' as const,
  durationMinutes: 60,
  defaultCapacity: 10,
  priceCents: 2000,
  currency: 'USD',
};

function denyInsufficientRole(): void {
  mockAuthorize.mockReturnValue({ allowed: false, reason: 'insufficient_role' });
}

function denyAnonymous(): void {
  mockAuthorize.mockReturnValue({ allowed: false, reason: 'anonymous' });
}

function allowAs(role: Role): void {
  mockAuthorize.mockReturnValue({ allowed: true, session: fixtureSession(role) });
}

interface ActionCase {
  readonly name: string;
  readonly action: (raw: unknown) => Promise<ActionResult<unknown>>;
  readonly payload: unknown;
  readonly mock: ReturnType<typeof vi.fn>;
  readonly resolvedValue: unknown;
}

function offeringActionCases(): readonly ActionCase[] {
  return [
    {
      name: 'createOfferingAction',
      action: createOfferingAction,
      payload: CREATE_PAYLOAD,
      mock: mockCreateOffering,
      resolvedValue: FIXTURE_OFFERING,
    },
    {
      name: 'updateOfferingAction',
      action: updateOfferingAction,
      payload: { offeringId: FIXTURE_OFFERING_ID, data: { name: 'Yoga 201' } },
      mock: mockUpdateOffering,
      resolvedValue: { before: FIXTURE_OFFERING, after: FIXTURE_OFFERING },
    },
    {
      name: 'publishOfferingAction',
      action: publishOfferingAction,
      payload: { offeringId: FIXTURE_OFFERING_ID },
      mock: mockTransitionOffering,
      resolvedValue: { offering: FIXTURE_OFFERING, changed: true },
    },
    {
      name: 'unpublishOfferingAction',
      action: unpublishOfferingAction,
      payload: { offeringId: FIXTURE_OFFERING_ID },
      mock: mockTransitionOffering,
      resolvedValue: { offering: FIXTURE_OFFERING, changed: true },
    },
    {
      name: 'archiveOfferingAction',
      action: archiveOfferingAction,
      payload: { offeringId: FIXTURE_OFFERING_ID },
      mock: mockTransitionOffering,
      resolvedValue: { offering: FIXTURE_OFFERING, changed: true },
    },
  ];
}

describe('offering actions', () => {
  beforeEach(() => {
    mockAuthorize.mockReset();
    mockGetSessionResult.mockReset();
    mockGetSessionResult.mockResolvedValue(authenticatedResult);
    mockRevalidatePath.mockClear();
    mockCreateOffering.mockReset();
    mockUpdateOffering.mockReset();
    mockTransitionOffering.mockReset();
  });

  // Test 1 — SC-12, must cover every one of the five offering actions.
  it('rejects a CUSTOMER caller for every offering action', async () => {
    for (const { action, payload, mock } of offeringActionCases()) {
      denyInsufficientRole();
      mock.mockClear();

      const result = await action(payload);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('FORBIDDEN');
      }
      expect(mock).not.toHaveBeenCalled();
    }
  });

  // Test 3 — staff are not managers.
  it('rejects a FRONT_OF_HOUSE caller for every offering action', async () => {
    for (const { action, payload, mock } of offeringActionCases()) {
      denyInsufficientRole();
      mock.mockClear();

      const result = await action(payload);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('FORBIDDEN');
      }
      expect(mock).not.toHaveBeenCalled();
    }
  });

  // Test 4 — MANAGER is allowed.
  it('allows a MANAGER caller for every offering action', async () => {
    for (const { action, payload, mock, resolvedValue } of offeringActionCases()) {
      allowAs('MANAGER');
      mock.mockReset();
      mock.mockResolvedValue(resolvedValue);

      const result = await action(payload);

      expect(mock).toHaveBeenCalledOnce();
      expect(result.ok).toBe(true);
    }
  });

  // Test 5 — MANAGER is a floor, not an equality check.
  it('allows an ADMIN caller for every offering action', async () => {
    for (const { action, payload, mock, resolvedValue } of offeringActionCases()) {
      allowAs('ADMIN');
      mock.mockReset();
      mock.mockResolvedValue(resolvedValue);

      const result = await action(payload);

      expect(mock).toHaveBeenCalledOnce();
      expect(result.ok).toBe(true);
    }
  });

  // Test 2
  it('rejects an anonymous caller', async () => {
    denyAnonymous();

    const result = await createOfferingAction(CREATE_PAYLOAD);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNAUTHENTICATED');
    }
    expect(mockCreateOffering).not.toHaveBeenCalled();
  });

  // Test 6 — authorization precedes validation.
  it('returns FORBIDDEN rather than VALIDATION when a denied caller also sends an invalid payload', async () => {
    denyInsufficientRole();

    const result = await createOfferingAction({ name: '' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FORBIDDEN');
    }
    expect(mockCreateOffering).not.toHaveBeenCalled();
  });

  // Test 7 — the actor comes from the session, never the payload.
  it('uses the session customerId as the actor even when the payload carries a different one', async () => {
    allowAs('MANAGER');
    mockTransitionOffering.mockResolvedValue({ offering: FIXTURE_OFFERING, changed: true });

    await publishOfferingAction({ offeringId: FIXTURE_OFFERING_ID, actorCustomerId: OTHER_CUSTOMER_ID });

    expect(mockTransitionOffering).toHaveBeenCalledWith(
      expect.objectContaining({ actorCustomerId: FIXTURE_CUSTOMER_ID }),
    );
  });

  // Test 8
  it('passes the parsed input through to createOffering', async () => {
    allowAs('MANAGER');
    mockCreateOffering.mockResolvedValue(FIXTURE_OFFERING);

    await createOfferingAction(CREATE_PAYLOAD);

    expect(mockCreateOffering).toHaveBeenCalledWith({
      data: CREATE_PAYLOAD,
      actorCustomerId: FIXTURE_CUSTOMER_ID,
    });
  });

  // Test 9 — transition actions fix their target status; a caller-chosen
  // status cannot override it.
  it('fixes the target status for each transition action regardless of a caller-supplied one', async () => {
    allowAs('MANAGER');
    mockTransitionOffering.mockResolvedValue({ offering: FIXTURE_OFFERING, changed: true });

    await publishOfferingAction({ offeringId: FIXTURE_OFFERING_ID, to: 'ARCHIVED' });
    expect(mockTransitionOffering).toHaveBeenLastCalledWith(expect.objectContaining({ to: 'PUBLISHED' }));

    await unpublishOfferingAction({ offeringId: FIXTURE_OFFERING_ID, to: 'ARCHIVED' });
    expect(mockTransitionOffering).toHaveBeenLastCalledWith(expect.objectContaining({ to: 'DRAFT' }));

    await archiveOfferingAction({ offeringId: FIXTURE_OFFERING_ID, to: 'DRAFT' });
    expect(mockTransitionOffering).toHaveBeenLastCalledWith(expect.objectContaining({ to: 'ARCHIVED' }));
  });

  // Test 10
  it('maps InvalidOfferingTransitionError to CONFLICT, naming both states', async () => {
    allowAs('MANAGER');
    mockTransitionOffering.mockRejectedValue(
      new InvalidOfferingTransitionError(FIXTURE_OFFERING_ID, 'ARCHIVED', 'PUBLISHED'),
    );

    const result = await publishOfferingAction({ offeringId: FIXTURE_OFFERING_ID });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('CONFLICT');
      expect(result.error.message).toContain('ARCHIVED');
      expect(result.error.message).toContain('PUBLISHED');
    }
  });

  it('maps OfferingNotFoundError to VALIDATION', async () => {
    allowAs('MANAGER');
    mockUpdateOffering.mockRejectedValue(new OfferingNotFoundError(FIXTURE_OFFERING_ID));

    const result = await updateOfferingAction({ offeringId: FIXTURE_OFFERING_ID, data: { name: 'New name' } });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
    }
  });

  it('maps UnsupportedOfferingTypeError to VALIDATION', async () => {
    allowAs('MANAGER');
    mockUpdateOffering.mockRejectedValue(new UnsupportedOfferingTypeError('ROOM'));

    const result = await updateOfferingAction({ offeringId: FIXTURE_OFFERING_ID, data: { name: 'New name' } });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
    }
  });

  // Test 14
  it('returns a generic INTERNAL message for an unmapped error and never leaks the original text', async () => {
    allowAs('MANAGER');
    const secret = 'postgresql://user:password@host/db';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockCreateOffering.mockRejectedValue(new Error(secret));

    const result = await createOfferingAction(CREATE_PAYLOAD);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INTERNAL');
      expect(result.error.message).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });

  // Test 16
  it('revalidates /book after publishing', async () => {
    allowAs('MANAGER');
    mockTransitionOffering.mockResolvedValue({ offering: FIXTURE_OFFERING, changed: true });

    await publishOfferingAction({ offeringId: FIXTURE_OFFERING_ID });

    expect(mockRevalidatePath).toHaveBeenCalledWith('/book');
  });

  // Test 17 — the route-level guard is the second independent boundary; a
  // Server Action is directly invocable, so the layout does not protect it
  // on its own.
  it('leaves the admin layout route guard in place', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const layoutSource = readFileSync(join(dir, '..', 'layout.tsx'), 'utf-8');
    expect(layoutSource).toMatch(/requireRole\(\s*['"]MANAGER['"]\s*\)/);
  });
});
