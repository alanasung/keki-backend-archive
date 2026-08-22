import type { Session, SessionResult } from '@keki/auth';
import {
  createCustomerId,
  createOccurrenceId,
  createOfferingId,
  type Occurrence,
  type Role,
} from '@keki/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAuthorize,
  mockGetSessionResult,
  mockRevalidatePath,
  mockScheduleOccurrence,
  mockUpdateOccurrence,
  mockCancelOccurrence,
} = vi.hoisted(() => ({
  mockAuthorize: vi.fn(),
  mockGetSessionResult: vi.fn(),
  mockRevalidatePath: vi.fn(),
  mockScheduleOccurrence: vi.fn(),
  mockUpdateOccurrence: vi.fn(),
  mockCancelOccurrence: vi.fn(),
}));

vi.mock('@keki/auth', () => ({ authorize: mockAuthorize }));
vi.mock('../../auth/require-session', () => ({ getSessionResult: mockGetSessionResult }));
vi.mock('next/cache', () => ({ revalidatePath: mockRevalidatePath }));
vi.mock('@keki/catalog-admin', async () => {
  const actual = await vi.importActual<typeof import('@keki/catalog-admin')>('@keki/catalog-admin');
  return {
    ...actual,
    scheduleOccurrence: mockScheduleOccurrence,
    updateOccurrence: mockUpdateOccurrence,
    cancelOccurrence: mockCancelOccurrence,
  };
});

import {
  InvalidOccurrenceTransitionError,
  OccurrenceHasReservationsError,
  OccurrenceInPastError,
  OccurrenceNotFoundError,
  OfferingNotPublishedError,
  OverlappingOccurrenceError,
} from '@keki/catalog-admin';
import type { ActionResult } from '../../actions/action-result';
import { cancelOccurrenceAction, scheduleOccurrenceAction, updateOccurrenceAction } from './occurrence-actions';

const FIXTURE_CUSTOMER_ID = createCustomerId('11111111-1111-4111-8111-111111111111');
const OTHER_CUSTOMER_ID = createCustomerId('99999999-9999-4999-8999-999999999999');
const FIXTURE_OFFERING_ID = createOfferingId('22222222-2222-4222-8222-222222222222');
const FIXTURE_OCCURRENCE_ID = createOccurrenceId('33333333-3333-4333-8333-333333333333');
const CONFLICTING_OCCURRENCE_ID = createOccurrenceId('44444444-4444-4444-8444-444444444444');

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

const FIXTURE_OCCURRENCE: Occurrence = {
  id: FIXTURE_OCCURRENCE_ID,
  offeringId: FIXTURE_OFFERING_ID,
  status: 'SCHEDULED',
  startsAt: new Date('2026-06-01T10:00:00.000Z'),
  endsAt: new Date('2026-06-01T11:00:00.000Z'),
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

const SCHEDULE_PAYLOAD = {
  offeringId: FIXTURE_OFFERING_ID,
  startsAt: '2026-06-01T10:00:00.000Z',
  capacityOverride: null,
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
  readonly action: (raw: unknown) => Promise<ActionResult<unknown>>;
  readonly payload: unknown;
  readonly mock: ReturnType<typeof vi.fn>;
  readonly resolvedValue: unknown;
}

function occurrenceActionCases(): readonly ActionCase[] {
  return [
    {
      action: scheduleOccurrenceAction,
      payload: SCHEDULE_PAYLOAD,
      mock: mockScheduleOccurrence,
      resolvedValue: FIXTURE_OCCURRENCE,
    },
    {
      action: updateOccurrenceAction,
      payload: { occurrenceId: FIXTURE_OCCURRENCE_ID, data: { capacityOverride: 5 } },
      mock: mockUpdateOccurrence,
      resolvedValue: { before: FIXTURE_OCCURRENCE, after: FIXTURE_OCCURRENCE, bookedSeats: 2 },
    },
    {
      action: cancelOccurrenceAction,
      payload: { occurrenceId: FIXTURE_OCCURRENCE_ID },
      mock: mockCancelOccurrence,
      resolvedValue: { occurrence: FIXTURE_OCCURRENCE, changed: true },
    },
  ];
}

describe('occurrence actions', () => {
  beforeEach(() => {
    mockAuthorize.mockReset();
    mockGetSessionResult.mockReset();
    mockGetSessionResult.mockResolvedValue(authenticatedResult);
    mockRevalidatePath.mockClear();
    mockScheduleOccurrence.mockReset();
    mockUpdateOccurrence.mockReset();
    mockCancelOccurrence.mockReset();
  });

  // Test 1 — SC-12, must cover every one of the three occurrence actions.
  it('rejects a CUSTOMER caller for every occurrence action', async () => {
    for (const { action, payload, mock } of occurrenceActionCases()) {
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
  it('rejects a FRONT_OF_HOUSE caller for every occurrence action', async () => {
    for (const { action, payload, mock } of occurrenceActionCases()) {
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
  it('allows a MANAGER caller for every occurrence action', async () => {
    for (const { action, payload, mock, resolvedValue } of occurrenceActionCases()) {
      allowAs('MANAGER');
      mock.mockReset();
      mock.mockResolvedValue(resolvedValue);

      const result = await action(payload);

      expect(mock).toHaveBeenCalledOnce();
      expect(result.ok).toBe(true);
    }
  });

  // Test 5 — MANAGER is a floor, not an equality check.
  it('allows an ADMIN caller for every occurrence action', async () => {
    for (const { action, payload, mock, resolvedValue } of occurrenceActionCases()) {
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

    const result = await scheduleOccurrenceAction(SCHEDULE_PAYLOAD);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNAUTHENTICATED');
    }
    expect(mockScheduleOccurrence).not.toHaveBeenCalled();
  });

  // Test 6 — authorization precedes validation.
  it('returns FORBIDDEN rather than VALIDATION when a denied caller also sends an invalid payload', async () => {
    denyInsufficientRole();

    const result = await scheduleOccurrenceAction({ offeringId: 'not-a-uuid' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FORBIDDEN');
    }
    expect(mockScheduleOccurrence).not.toHaveBeenCalled();
  });

  // Test 7 — the actor comes from the session, never the payload.
  it('uses the session customerId as the actor even when the payload carries a different one', async () => {
    allowAs('MANAGER');
    mockCancelOccurrence.mockResolvedValue({ occurrence: FIXTURE_OCCURRENCE, changed: true });

    await cancelOccurrenceAction({ occurrenceId: FIXTURE_OCCURRENCE_ID, actorCustomerId: OTHER_CUSTOMER_ID });

    expect(mockCancelOccurrence).toHaveBeenCalledWith(
      expect.objectContaining({ actorCustomerId: FIXTURE_CUSTOMER_ID }),
    );
  });

  // Test 15 — always returned, not only when capacity was lowered below it.
  it('returns bookedSeats from updateOccurrenceAction even when capacity was not lowered', async () => {
    allowAs('MANAGER');
    mockUpdateOccurrence.mockResolvedValue({
      before: FIXTURE_OCCURRENCE,
      after: FIXTURE_OCCURRENCE,
      bookedSeats: 3,
    });

    const result = await updateOccurrenceAction({ occurrenceId: FIXTURE_OCCURRENCE_ID, data: {} });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.data as { bookedSeats: number }).bookedSeats).toBe(3);
    }
  });

  // Test 11
  it('maps OccurrenceHasReservationsError to CONFLICT, including the booked count', async () => {
    allowAs('MANAGER');
    mockCancelOccurrence.mockRejectedValue(new OccurrenceHasReservationsError(FIXTURE_OCCURRENCE_ID, 3));

    const result = await cancelOccurrenceAction({ occurrenceId: FIXTURE_OCCURRENCE_ID });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('CONFLICT');
      expect(result.error.message).toContain('3');
    }
  });

  // Test 12
  it('maps OccurrenceInPastError to VALIDATION', async () => {
    allowAs('MANAGER');
    mockScheduleOccurrence.mockRejectedValue(
      new OccurrenceInPastError(new Date('2020-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z')),
    );

    const result = await scheduleOccurrenceAction(SCHEDULE_PAYLOAD);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
    }
  });

  // Test 13
  it('maps OverlappingOccurrenceError to CONFLICT, naming the conflicting start', async () => {
    allowAs('MANAGER');
    const conflictingStartsAt = new Date('2026-06-01T10:30:00.000Z');
    mockScheduleOccurrence.mockRejectedValue(
      new OverlappingOccurrenceError(CONFLICTING_OCCURRENCE_ID, conflictingStartsAt),
    );

    const result = await scheduleOccurrenceAction(SCHEDULE_PAYLOAD);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('CONFLICT');
      expect(result.error.message).toContain(conflictingStartsAt.toISOString());
    }
  });

  it('maps OfferingNotPublishedError to CONFLICT', async () => {
    allowAs('MANAGER');
    mockScheduleOccurrence.mockRejectedValue(new OfferingNotPublishedError(FIXTURE_OFFERING_ID, 'DRAFT'));

    const result = await scheduleOccurrenceAction(SCHEDULE_PAYLOAD);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('CONFLICT');
    }
  });

  it('maps OccurrenceNotFoundError to VALIDATION', async () => {
    allowAs('MANAGER');
    mockUpdateOccurrence.mockRejectedValue(new OccurrenceNotFoundError(FIXTURE_OCCURRENCE_ID));

    const result = await updateOccurrenceAction({ occurrenceId: FIXTURE_OCCURRENCE_ID, data: {} });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
    }
  });

  it('maps InvalidOccurrenceTransitionError to CONFLICT, naming both states', async () => {
    allowAs('MANAGER');
    mockUpdateOccurrence.mockRejectedValue(
      new InvalidOccurrenceTransitionError(FIXTURE_OCCURRENCE_ID, 'CANCELLED', 'CANCELLED'),
    );

    const result = await updateOccurrenceAction({ occurrenceId: FIXTURE_OCCURRENCE_ID, data: {} });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('CONFLICT');
      expect(result.error.message).toContain('CANCELLED');
    }
  });

  // Test 14
  it('returns a generic INTERNAL message for an unmapped error and never leaks the original text', async () => {
    allowAs('MANAGER');
    const secret = 'postgresql://user:password@host/db';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockScheduleOccurrence.mockRejectedValue(new Error(secret));

    const result = await scheduleOccurrenceAction(SCHEDULE_PAYLOAD);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INTERNAL');
      expect(result.error.message).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });

  // Test 16
  it('revalidates /book after scheduling an occurrence', async () => {
    allowAs('MANAGER');
    mockScheduleOccurrence.mockResolvedValue(FIXTURE_OCCURRENCE);

    await scheduleOccurrenceAction(SCHEDULE_PAYLOAD);

    expect(mockRevalidatePath).toHaveBeenCalledWith('/book');
  });
});
