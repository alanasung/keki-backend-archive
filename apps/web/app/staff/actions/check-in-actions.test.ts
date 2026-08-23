import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Session, SessionResult } from '@keki/auth';
import { createCustomerId, createReservationId, createReservationParticipantId, type Role } from '@keki/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAuthorize,
  mockGetSessionResult,
  mockRevalidatePath,
  mockCheckInParticipant,
  mockUndoCheckInParticipant,
  mockMarkReservationNoShow,
} = vi.hoisted(() => ({
  mockAuthorize: vi.fn(),
  mockGetSessionResult: vi.fn(),
  mockRevalidatePath: vi.fn(),
  mockCheckInParticipant: vi.fn(),
  mockUndoCheckInParticipant: vi.fn(),
  mockMarkReservationNoShow: vi.fn(),
}));

vi.mock('@keki/auth', () => ({ authorize: mockAuthorize }));
vi.mock('../../auth/require-session', () => ({ getSessionResult: mockGetSessionResult }));
vi.mock('next/cache', () => ({ revalidatePath: mockRevalidatePath }));
vi.mock('@keki/staff-ops', async () => {
  const actual = await vi.importActual<typeof import('@keki/staff-ops')>('@keki/staff-ops');
  return {
    ...actual,
    checkInParticipant: mockCheckInParticipant,
    undoCheckInParticipant: mockUndoCheckInParticipant,
    markReservationNoShow: mockMarkReservationNoShow,
  };
});

import {
  ReservationNotCheckInEligibleError,
  ReservationParticipantNotFoundError,
  InvalidReservationTransitionError,
} from '@keki/staff-ops';
import type { ActionResult } from '../../actions/action-result';
import { checkInParticipantAction, markNoShowAction, undoCheckInParticipantAction } from './check-in-actions';

const FIXTURE_CUSTOMER_ID = createCustomerId('11111111-1111-4111-8111-111111111111');
const OTHER_CUSTOMER_ID = createCustomerId('99999999-9999-4999-8999-999999999999');
const VALID_PARTICIPANT_ID = '22222222-2222-4222-8222-222222222222';
const VALID_RESERVATION_ID = '33333333-3333-4333-8333-333333333333';

function fixtureSession(role: Role): Session {
  return {
    cognitoSub: 'cognito-sub-1',
    profile: {
      customerId: FIXTURE_CUSTOMER_ID,
      householdId: null,
      email: 'staff@example.com',
      firstName: 'Sam',
      lastName: 'Staffer',
      role,
    },
  };
}

const authenticatedResult: SessionResult = { kind: 'authenticated', session: fixtureSession('FRONT_OF_HOUSE') };

function denyInsufficientRole(): void {
  mockAuthorize.mockReturnValue({ allowed: false, reason: 'insufficient_role' });
}

function denyAnonymous(): void {
  mockAuthorize.mockReturnValue({ allowed: false, reason: 'anonymous' });
}

function denyUnprovisioned(): void {
  mockAuthorize.mockReturnValue({ allowed: false, reason: 'unprovisioned' });
}

function allowAs(role: Role): void {
  mockAuthorize.mockReturnValue({ allowed: true, session: fixtureSession(role) });
}

interface ActionCase {
  readonly name: string;
  readonly action: (raw: unknown) => Promise<ActionResult<unknown>>;
  readonly payload: unknown;
  readonly malformedPayload: unknown;
  readonly mock: ReturnType<typeof vi.fn>;
  readonly resolvedValue: unknown;
}

function actionCases(): readonly ActionCase[] {
  return [
    {
      name: 'checkInParticipantAction',
      action: checkInParticipantAction,
      payload: { reservationParticipantId: VALID_PARTICIPANT_ID },
      malformedPayload: { reservationParticipantId: 'not-a-uuid' },
      mock: mockCheckInParticipant,
      resolvedValue: {
        participantId: createReservationParticipantId(VALID_PARTICIPANT_ID),
        reservationId: createReservationId(VALID_RESERVATION_ID),
        checkedInAt: new Date('2026-01-01T12:00:00Z'),
        reservationStatus: 'CHECKED_IN',
        changed: true,
      },
    },
    {
      name: 'undoCheckInParticipantAction',
      action: undoCheckInParticipantAction,
      payload: { reservationParticipantId: VALID_PARTICIPANT_ID },
      malformedPayload: { reservationParticipantId: 'not-a-uuid' },
      mock: mockUndoCheckInParticipant,
      resolvedValue: {
        reservationId: createReservationId(VALID_RESERVATION_ID),
        reservationStatus: 'CONFIRMED',
        changed: true,
      },
    },
    {
      name: 'markNoShowAction',
      action: markNoShowAction,
      payload: { reservationId: VALID_RESERVATION_ID },
      malformedPayload: { reservationId: 'not-a-uuid' },
      mock: mockMarkReservationNoShow,
      resolvedValue: {
        reservationId: createReservationId(VALID_RESERVATION_ID),
        changed: true,
      },
    },
  ];
}

describe('check-in actions', () => {
  beforeEach(() => {
    mockAuthorize.mockReset();
    mockGetSessionResult.mockReset();
    mockGetSessionResult.mockResolvedValue(authenticatedResult);
    mockRevalidatePath.mockClear();
    mockCheckInParticipant.mockReset();
    mockUndoCheckInParticipant.mockReset();
    mockMarkReservationNoShow.mockReset();
  });

  // Test 1 — SC-13, must cover every one of the three actions.
  it('rejects a CUSTOMER caller for every action', async () => {
    for (const { action, payload, mock } of actionCases()) {
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

  // Test 2
  it('rejects an anonymous caller', async () => {
    for (const { action, payload, mock } of actionCases()) {
      denyAnonymous();
      mock.mockClear();

      const result = await action(payload);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('UNAUTHENTICATED');
      }
      expect(mock).not.toHaveBeenCalled();
    }
  });

  // Test 3
  it('rejects an unprovisioned caller', async () => {
    for (const { action, payload, mock } of actionCases()) {
      denyUnprovisioned();
      mock.mockClear();

      const result = await action(payload);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('UNPROVISIONED');
      }
      expect(mock).not.toHaveBeenCalled();
    }
  });

  // Test 4 — the boundary this workstream exists to establish.
  it('allows a FRONT_OF_HOUSE caller for every action', async () => {
    for (const { action, payload, mock, resolvedValue } of actionCases()) {
      allowAs('FRONT_OF_HOUSE');
      mock.mockReset();
      mock.mockResolvedValue(resolvedValue);

      const result = await action(payload);

      expect(mock).toHaveBeenCalledOnce();
      expect(result.ok).toBe(true);
    }
  });

  // Test 5 — FRONT_OF_HOUSE is a floor, not an equality check.
  it('allows a MANAGER caller for every action', async () => {
    for (const { action, payload, mock, resolvedValue } of actionCases()) {
      allowAs('MANAGER');
      mock.mockReset();
      mock.mockResolvedValue(resolvedValue);

      const result = await action(payload);

      expect(mock).toHaveBeenCalledOnce();
      expect(result.ok).toBe(true);
    }
  });

  // Test 6 — covering the top of the ladder.
  it('allows an ADMIN caller for every action', async () => {
    for (const { action, payload, mock, resolvedValue } of actionCases()) {
      allowAs('ADMIN');
      mock.mockReset();
      mock.mockResolvedValue(resolvedValue);

      const result = await action(payload);

      expect(mock).toHaveBeenCalledOnce();
      expect(result.ok).toBe(true);
    }
  });

  // Test 7 — authorization precedes validation.
  it('returns FORBIDDEN rather than VALIDATION when a denied caller also sends an invalid payload', async () => {
    for (const { action, malformedPayload, mock } of actionCases()) {
      denyInsufficientRole();
      mock.mockClear();

      const result = await action(malformedPayload);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('FORBIDDEN');
      }
      expect(mock).not.toHaveBeenCalled();
    }
  });

  // Test 8 — the actor comes from the session, never the payload. The
  // schemas are `.strict()` and have no `actorCustomerId` field at all, so a
  // payload that smuggles one is rejected outright rather than silently
  // stripped — a stronger guarantee than "ignored".
  it('rejects a payload carrying a different actorCustomerId, and uses the session customerId on a well-formed one', async () => {
    allowAs('FRONT_OF_HOUSE');

    const smuggledResult = await checkInParticipantAction({
      reservationParticipantId: VALID_PARTICIPANT_ID,
      actorCustomerId: OTHER_CUSTOMER_ID,
    });
    expect(smuggledResult.ok).toBe(false);
    if (!smuggledResult.ok) {
      expect(smuggledResult.error.code).toBe('VALIDATION');
    }
    expect(mockCheckInParticipant).not.toHaveBeenCalled();

    mockCheckInParticipant.mockResolvedValue({
      participantId: createReservationParticipantId(VALID_PARTICIPANT_ID),
      reservationId: createReservationId(VALID_RESERVATION_ID),
      checkedInAt: new Date('2026-01-01T12:00:00Z'),
      reservationStatus: 'CHECKED_IN',
      changed: true,
    });

    await checkInParticipantAction({ reservationParticipantId: VALID_PARTICIPANT_ID });

    expect(mockCheckInParticipant).toHaveBeenCalledWith(
      expect.objectContaining({ actorCustomerId: FIXTURE_CUSTOMER_ID }),
    );
  });

  // Test 9 — an attendance record can never be backdated through the
  // action. Same strict-schema mechanism as test 8: neither field exists on
  // the schema, so a payload carrying either is rejected outright.
  it('rejects a payload carrying now or checkedInAt, and never forwards them on a well-formed call', async () => {
    allowAs('FRONT_OF_HOUSE');

    const smuggledResult = await checkInParticipantAction({
      reservationParticipantId: VALID_PARTICIPANT_ID,
      now: new Date().toISOString(),
      checkedInAt: new Date().toISOString(),
    });
    expect(smuggledResult.ok).toBe(false);
    if (!smuggledResult.ok) {
      expect(smuggledResult.error.code).toBe('VALIDATION');
    }
    expect(mockCheckInParticipant).not.toHaveBeenCalled();

    mockCheckInParticipant.mockResolvedValue({
      participantId: createReservationParticipantId(VALID_PARTICIPANT_ID),
      reservationId: createReservationId(VALID_RESERVATION_ID),
      checkedInAt: new Date('2026-01-01T12:00:00Z'),
      reservationStatus: 'CHECKED_IN',
      changed: true,
    });

    await checkInParticipantAction({ reservationParticipantId: VALID_PARTICIPANT_ID });

    const callArgs = mockCheckInParticipant.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArgs).not.toHaveProperty('now');
    expect(callArgs).not.toHaveProperty('checkedInAt');
  });

  // Test 10
  it('passes the parsed participant id through to checkInParticipant', async () => {
    allowAs('FRONT_OF_HOUSE');
    mockCheckInParticipant.mockResolvedValue({
      participantId: createReservationParticipantId(VALID_PARTICIPANT_ID),
      reservationId: createReservationId(VALID_RESERVATION_ID),
      checkedInAt: new Date('2026-01-01T12:00:00Z'),
      reservationStatus: 'CHECKED_IN',
      changed: true,
    });

    await checkInParticipantAction({ reservationParticipantId: VALID_PARTICIPANT_ID });

    expect(mockCheckInParticipant).toHaveBeenCalledWith(
      expect.objectContaining({ reservationParticipantId: VALID_PARTICIPANT_ID }),
    );
  });

  // Test 11
  it('returns VALIDATION for a malformed uuid without calling the command', async () => {
    for (const { action, malformedPayload, mock } of actionCases()) {
      allowAs('FRONT_OF_HOUSE');
      mock.mockClear();

      const result = await action(malformedPayload);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('VALIDATION');
      }
      expect(mock).not.toHaveBeenCalled();
    }
  });

  // Test 12 — an idempotent repeat is a success, not an error.
  it('returns changed: false as a success', async () => {
    allowAs('FRONT_OF_HOUSE');
    mockCheckInParticipant.mockResolvedValue({
      participantId: createReservationParticipantId(VALID_PARTICIPANT_ID),
      reservationId: createReservationId(VALID_RESERVATION_ID),
      checkedInAt: new Date('2026-01-01T12:00:00Z'),
      reservationStatus: 'CHECKED_IN',
      changed: false,
    });

    const result = await checkInParticipantAction({ reservationParticipantId: VALID_PARTICIPANT_ID });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.data as { changed: boolean }).changed).toBe(false);
    }
  });

  // Test 13 — SC-07.
  it('maps ReservationNotCheckInEligibleError to CONFLICT, naming the current status', async () => {
    allowAs('FRONT_OF_HOUSE');
    mockCheckInParticipant.mockRejectedValue(
      new ReservationNotCheckInEligibleError(createReservationId(VALID_RESERVATION_ID), 'HELD'),
    );

    const result = await checkInParticipantAction({ reservationParticipantId: VALID_PARTICIPANT_ID });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('CONFLICT');
      expect(result.error.message).toContain('HELD');
    }
  });

  // Test 14 — SC-09.
  it('maps InvalidReservationTransitionError to CONFLICT, naming both states', async () => {
    allowAs('FRONT_OF_HOUSE');
    mockMarkReservationNoShow.mockRejectedValue(
      new InvalidReservationTransitionError(createReservationId(VALID_RESERVATION_ID), 'CHECKED_IN', 'NO_SHOW'),
    );

    const result = await markNoShowAction({ reservationId: VALID_RESERVATION_ID });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('CONFLICT');
      expect(result.error.message).toContain('CHECKED_IN');
      expect(result.error.message).toContain('NO_SHOW');
    }
  });

  // Test 15
  it('maps ReservationParticipantNotFoundError to VALIDATION', async () => {
    allowAs('FRONT_OF_HOUSE');
    mockCheckInParticipant.mockRejectedValue(
      new ReservationParticipantNotFoundError(createReservationParticipantId(VALID_PARTICIPANT_ID)),
    );

    const result = await checkInParticipantAction({ reservationParticipantId: VALID_PARTICIPANT_ID });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
    }
  });

  // Test 16
  it('returns a generic INTERNAL message for an unmapped error and never leaks the original text', async () => {
    allowAs('FRONT_OF_HOUSE');
    const secret = 'postgresql://user:password@host/db';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockCheckInParticipant.mockRejectedValue(new Error(secret));

    const result = await checkInParticipantAction({ reservationParticipantId: VALID_PARTICIPANT_ID });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INTERNAL');
      expect(result.error.message).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });

  // Test 17 — the screen a staff member walks to next after a check-in.
  it('revalidates /staff/occupancy after a check-in', async () => {
    allowAs('FRONT_OF_HOUSE');
    mockCheckInParticipant.mockResolvedValue({
      participantId: createReservationParticipantId(VALID_PARTICIPANT_ID),
      reservationId: createReservationId(VALID_RESERVATION_ID),
      checkedInAt: new Date('2026-01-01T12:00:00Z'),
      reservationStatus: 'CHECKED_IN',
      changed: true,
    });

    await checkInParticipantAction({ reservationParticipantId: VALID_PARTICIPANT_ID });

    expect(mockRevalidatePath).toHaveBeenCalledWith('/staff/occupancy');
  });

  // Test 18 — the arrived count changes.
  it('revalidates /staff/today after a check-in', async () => {
    allowAs('FRONT_OF_HOUSE');
    mockCheckInParticipant.mockResolvedValue({
      participantId: createReservationParticipantId(VALID_PARTICIPANT_ID),
      reservationId: createReservationId(VALID_RESERVATION_ID),
      checkedInAt: new Date('2026-01-01T12:00:00Z'),
      reservationStatus: 'CHECKED_IN',
      changed: true,
    });

    await checkInParticipantAction({ reservationParticipantId: VALID_PARTICIPANT_ID });

    expect(mockRevalidatePath).toHaveBeenCalledWith('/staff/today');
  });

  // Test 19 — the route-level guard is the second independent boundary; a
  // Server Action is directly invocable, so the layout does not protect it
  // on its own.
  it('leaves the staff layout route guard in place', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const layoutSource = readFileSync(join(dir, '..', 'layout.tsx'), 'utf-8');
    expect(layoutSource).toMatch(/requireRole\(\s*['"]FRONT_OF_HOUSE['"]\s*\)/);
  });
});
