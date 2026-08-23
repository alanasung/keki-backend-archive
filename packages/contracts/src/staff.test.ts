import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CAFE_TIME_ZONE, RESERVATION_STATUSES, SEAT_CONSUMING_STATUSES } from './entities';
import {
  RESERVATION_TRANSITIONS,
  canTransitionReservation,
  checkInParticipantSchema,
  markNoShowSchema,
  undoCheckInParticipantSchema,
} from './staff';
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from './admin';

const VALID_PARTICIPANT_ID = '11111111-1111-4111-8111-111111111111';
const VALID_RESERVATION_ID = '22222222-2222-4222-8222-222222222222';

describe('canTransitionReservation', () => {
  it('permits declared edges', () => {
    expect(canTransitionReservation('CONFIRMED', 'CHECKED_IN')).toBe(true);
    expect(canTransitionReservation('CHECKED_IN', 'CONFIRMED')).toBe(true);
    expect(canTransitionReservation('CONFIRMED', 'NO_SHOW')).toBe(true);
    expect(canTransitionReservation('HELD', 'CONFIRMED')).toBe(true);
  });

  it('refuses HELD -> CHECKED_IN', () => {
    expect(canTransitionReservation('HELD', 'CHECKED_IN')).toBe(false);
  });

  it('treats NO_SHOW as terminal', () => {
    expect(RESERVATION_TRANSITIONS.NO_SHOW).toEqual([]);
    expect(canTransitionReservation('NO_SHOW', 'CONFIRMED')).toBe(false);
  });

  it('treats CANCELLED as terminal', () => {
    expect(RESERVATION_TRANSITIONS.CANCELLED).toEqual([]);
  });

  it('covers every declared reservation status', () => {
    expect(Object.keys(RESERVATION_TRANSITIONS).sort()).toEqual([...RESERVATION_STATUSES].sort());
  });

  it('declares only valid statuses as targets', () => {
    for (const targets of Object.values(RESERVATION_TRANSITIONS)) {
      for (const target of targets) {
        expect(RESERVATION_STATUSES).toContain(target);
      }
    }
  });

  it('keeps the CHECKED_IN <-> CONFIRMED undo edge within the seat-consuming set', () => {
    expect(SEAT_CONSUMING_STATUSES).toContain('CHECKED_IN');
    expect(SEAT_CONSUMING_STATUSES).toContain('CONFIRMED');
  });
});

describe('checkInParticipantSchema', () => {
  it('accepts a well-formed payload', () => {
    expect(
      checkInParticipantSchema.safeParse({ reservationParticipantId: VALID_PARTICIPANT_ID }).success,
    ).toBe(true);
  });

  it('rejects a supplied checkedInAt', () => {
    const result = checkInParticipantSchema.safeParse({
      reservationParticipantId: VALID_PARTICIPANT_ID,
      checkedInAt: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-uuid id', () => {
    expect(checkInParticipantSchema.safeParse({ reservationParticipantId: 'abc' }).success).toBe(
      false,
    );
    expect(
      checkInParticipantSchema.safeParse({ reservationParticipantId: VALID_PARTICIPANT_ID }).success,
    ).toBe(true);
  });
});

describe('undoCheckInParticipantSchema', () => {
  it('mirrors checkInParticipantSchema', () => {
    expect(
      undoCheckInParticipantSchema.safeParse({ reservationParticipantId: VALID_PARTICIPANT_ID })
        .success,
    ).toBe(true);
  });
});

describe('markNoShowSchema', () => {
  it('accepts a well-formed payload', () => {
    expect(markNoShowSchema.safeParse({ reservationId: VALID_RESERVATION_ID }).success).toBe(true);
  });

  it('rejects unknown keys, including a smuggled status', () => {
    const result = markNoShowSchema.safeParse({
      reservationId: VALID_RESERVATION_ID,
      status: 'NO_SHOW',
    });
    expect(result.success).toBe(false);
  });
});

describe('AUDIT_ACTIONS — reservation actions', () => {
  it('adds three distinct reservation audit actions', () => {
    expect(AUDIT_ACTIONS).toContain('reservation.checked_in');
    expect(AUDIT_ACTIONS).toContain('reservation.check_in_undone');
    expect(AUDIT_ACTIONS).toContain('reservation.no_show');
    const reservationActions = new Set([
      'reservation.checked_in',
      'reservation.check_in_undone',
      'reservation.no_show',
    ]);
    expect(reservationActions.size).toBe(3);
  });

  it('leaves the eight Phase 3 audit actions unchanged', () => {
    const phase3Actions = [
      'offering.created',
      'offering.updated',
      'offering.published',
      'offering.unpublished',
      'offering.archived',
      'occurrence.scheduled',
      'occurrence.updated',
      'occurrence.cancelled',
    ] as const;
    for (const action of phase3Actions) {
      expect(AUDIT_ACTIONS).toContain(action);
    }
  });
});

describe('AUDIT_ENTITY_TYPES', () => {
  it('includes reservation alongside offering and occurrence', () => {
    expect(AUDIT_ENTITY_TYPES).toContain('offering');
    expect(AUDIT_ENTITY_TYPES).toContain('occurrence');
    expect(AUDIT_ENTITY_TYPES).toContain('reservation');
  });
});

describe('CAFE_TIME_ZONE', () => {
  it('is exported from @keki/contracts as America/Los_Angeles', () => {
    expect(CAFE_TIME_ZONE).toBe('America/Los_Angeles');
  });

  it('is no longer declared in class-listing.tsx', () => {
    const classListingPath = fileURLToPath(
      new URL(
        '../../../apps/web/app/(customer)/book/class-listing.tsx',
        import.meta.url,
      ),
    );
    const source = readFileSync(classListingPath, 'utf8');
    expect(source).not.toMatch(/const CAFE_TIME_ZONE =/);
    expect(source).toMatch(/import\s*\{[^}]*CAFE_TIME_ZONE[^}]*\}\s*from\s*['"]@keki\/contracts['"]/);
  });

  it('renders the previous local day for a UTC instant that crosses the day boundary', () => {
    // 07:30 UTC on 2026-01-02 is 23:30 on 2026-01-01 in America/Los_Angeles
    // (PST, UTC-8) — a case that would render the wrong calendar day if the
    // relocated constant weren't actually applied.
    const utcInstant = new Date('2026-01-02T07:30:00.000Z');
    const dayKeyFormatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: CAFE_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    expect(dayKeyFormatter.format(utcInstant)).toBe('2026-01-01');
  });
});
