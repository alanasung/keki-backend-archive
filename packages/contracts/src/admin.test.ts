import { describe, expect, it } from 'vitest';
import { OCCURRENCE_STATUSES, OFFERING_STATUSES } from './entities';
import {
  AUDIT_ACTIONS,
  OCCURRENCE_TRANSITIONS,
  OFFERING_TRANSITIONS,
  canTransitionOccurrence,
  canTransitionOffering,
  createOfferingSchema,
  scheduleOccurrenceSchema,
} from './admin';

const VALID_OFFERING_ID = '11111111-1111-4111-8111-111111111111';

describe('canTransitionOffering', () => {
  it('permits declared edges', () => {
    expect(canTransitionOffering('DRAFT', 'PUBLISHED')).toBe(true);
    expect(canTransitionOffering('PUBLISHED', 'ARCHIVED')).toBe(true);
    expect(canTransitionOffering('PUBLISHED', 'DRAFT')).toBe(true);
  });

  it('refuses undeclared edges', () => {
    expect(canTransitionOffering('ARCHIVED', 'PUBLISHED')).toBe(false);
    expect(canTransitionOffering('ARCHIVED', 'DRAFT')).toBe(false);
  });

  it('treats ARCHIVED as terminal', () => {
    expect(OFFERING_TRANSITIONS.ARCHIVED).toEqual([]);
  });

  it('covers every declared offering status', () => {
    expect(Object.keys(OFFERING_TRANSITIONS).sort()).toEqual([...OFFERING_STATUSES].sort());
  });
});

describe('canTransitionOccurrence', () => {
  it('permits only cancel and complete from SCHEDULED', () => {
    expect(canTransitionOccurrence('SCHEDULED', 'CANCELLED')).toBe(true);
    expect(canTransitionOccurrence('SCHEDULED', 'COMPLETED')).toBe(true);
    expect(canTransitionOccurrence('CANCELLED', 'SCHEDULED')).toBe(false);
  });

  it('covers every declared occurrence status', () => {
    expect(Object.keys(OCCURRENCE_TRANSITIONS).sort()).toEqual([...OCCURRENCE_STATUSES].sort());
  });
});

describe('createOfferingSchema', () => {
  const validPayload = {
    name: 'Pottery',
    description: 'Hand-building basics',
    type: 'CLASS' as const,
    durationMinutes: 60,
    defaultCapacity: 10,
    priceCents: 2500,
    currency: 'USD',
  };

  it('accepts a well-formed payload', () => {
    expect(createOfferingSchema.safeParse(validPayload).success).toBe(true);
  });

  it('rejects a supplied slug', () => {
    const result = createOfferingSchema.safeParse({ ...validPayload, slug: 'x' });
    expect(result.success).toBe(false);
  });

  it('rejects a supplied status', () => {
    const result = createOfferingSchema.safeParse({ ...validPayload, status: 'ARCHIVED' });
    expect(result.success).toBe(false);
  });

  it('rejects a non-CLASS type', () => {
    expect(createOfferingSchema.safeParse({ ...validPayload, type: 'ROOM' }).success).toBe(false);
    expect(createOfferingSchema.safeParse({ ...validPayload, type: 'OPEN_PLAY' }).success).toBe(
      false,
    );
    expect(createOfferingSchema.safeParse({ ...validPayload, type: 'CLASS' }).success).toBe(true);
  });

  it('enforces duration bounds', () => {
    expect(createOfferingSchema.safeParse({ ...validPayload, durationMinutes: 4 }).success).toBe(
      false,
    );
    expect(
      createOfferingSchema.safeParse({ ...validPayload, durationMinutes: 601 }).success,
    ).toBe(false);
    expect(createOfferingSchema.safeParse({ ...validPayload, durationMinutes: 5 }).success).toBe(
      true,
    );
    expect(
      createOfferingSchema.safeParse({ ...validPayload, durationMinutes: 600 }).success,
    ).toBe(true);
  });

  it('requires capacity of at least one', () => {
    expect(createOfferingSchema.safeParse({ ...validPayload, defaultCapacity: 0 }).success).toBe(
      false,
    );
    expect(createOfferingSchema.safeParse({ ...validPayload, defaultCapacity: -1 }).success).toBe(
      false,
    );
    expect(createOfferingSchema.safeParse({ ...validPayload, defaultCapacity: 1 }).success).toBe(
      true,
    );
  });

  it('rejects a non-integer priceCents', () => {
    expect(createOfferingSchema.safeParse({ ...validPayload, priceCents: 4.5 }).success).toBe(
      false,
    );
    expect(createOfferingSchema.safeParse({ ...validPayload, priceCents: 0 }).success).toBe(true);
  });

  it('trims name and rejects blank input', () => {
    expect(createOfferingSchema.safeParse({ ...validPayload, name: '   ' }).success).toBe(false);

    const result = createOfferingSchema.safeParse({ ...validPayload, name: '  Pottery ' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('Pottery');
    }
  });
});

describe('scheduleOccurrenceSchema', () => {
  const validPayload = {
    offeringId: VALID_OFFERING_ID,
    startsAt: '2026-01-01T12:00:00.000Z',
    capacityOverride: null,
  };

  it('rejects a supplied endsAt', () => {
    const result = scheduleOccurrenceSchema.safeParse({
      ...validPayload,
      endsAt: '2026-01-01T13:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('coerces an ISO string to a Date', () => {
    const result = scheduleOccurrenceSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.startsAt).toBeInstanceOf(Date);
    }
  });

  it('accepts null for capacityOverride', () => {
    expect(scheduleOccurrenceSchema.safeParse(validPayload).success).toBe(true);
  });
});

describe('AUDIT_ACTIONS', () => {
  it('has no duplicate members', () => {
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
  });

  it('includes distinct publish and unpublish actions', () => {
    expect(AUDIT_ACTIONS).toContain('offering.published');
    expect(AUDIT_ACTIONS).toContain('offering.unpublished');
  });
});
