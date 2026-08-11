import { describe, expect, it } from 'vitest';
import { cartLineSchema, cartSchema } from './catalog';
import type { CartParticipantRef, HouseholdMemberView } from './catalog';

const VALID_CATALOG_ITEM_ID = '11111111-1111-4111-8111-111111111111';
const VALID_OCCURRENCE_ID = '22222222-2222-4222-8222-222222222222';
const VALID_CUSTOMER_ID = '33333333-3333-4333-8333-333333333333';
const VALID_CHILD_ID = '44444444-4444-4444-8444-444444444444';
const VALID_OCCURRENCE_ID_2 = '55555555-5555-4555-8555-555555555555';

function catalogLine(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'CATALOG_ITEM',
    catalogItemId: VALID_CATALOG_ITEM_ID,
    quantity: 1,
    ...overrides,
  };
}

function occurrenceLine(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'OCCURRENCE',
    occurrenceId: VALID_OCCURRENCE_ID,
    participants: [{ kind: 'CUSTOMER', customerId: VALID_CUSTOMER_ID }],
    ...overrides,
  };
}

describe('cartLineSchema', () => {
  it('rejects a client-supplied price on a catalog line', () => {
    const result = cartLineSchema.safeParse(catalogLine({ unitPriceCents: 500 }));
    expect(result.success).toBe(false);
  });

  it('rejects an occurrence line that also carries a quantity field', () => {
    const result = cartLineSchema.safeParse(occurrenceLine({ quantity: 2 }));
    expect(result.success).toBe(false);
  });

  it('rejects an occurrence line with zero participants', () => {
    const result = cartLineSchema.safeParse(occurrenceLine({ participants: [] }));
    expect(result.success).toBe(false);
  });

  it('rejects an occurrence line with 11 participants', () => {
    const participants = Array.from({ length: 11 }, (_unused, index) => ({
      kind: 'CHILD' as const,
      childId: `${index.toString().padStart(8, '0')}-0000-4000-8000-000000000000`,
    }));
    expect(cartLineSchema.safeParse(occurrenceLine({ participants })).success).toBe(false);
  });

  it('accepts an occurrence line with 10 participants', () => {
    const participants = Array.from({ length: 10 }, (_unused, index) => ({
      kind: 'CHILD' as const,
      childId: `${index.toString().padStart(8, '0')}-0000-4000-8000-000000000000`,
    }));
    expect(cartLineSchema.safeParse(occurrenceLine({ participants })).success).toBe(true);
  });

  it('rejects a participant ref carrying both customerId and childId', () => {
    const result = cartLineSchema.safeParse(
      occurrenceLine({
        participants: [{ kind: 'CUSTOMER', customerId: VALID_CUSTOMER_ID, childId: VALID_CHILD_ID }],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects duplicate participants within one occurrence line', () => {
    const result = cartLineSchema.safeParse(
      occurrenceLine({
        participants: [
          { kind: 'CHILD', childId: VALID_CHILD_ID },
          { kind: 'CHILD', childId: VALID_CHILD_ID },
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('allows the same child to appear on two different occurrence lines', () => {
    const cart = {
      lines: [
        occurrenceLine({ participants: [{ kind: 'CHILD', childId: VALID_CHILD_ID }] }),
        occurrenceLine({
          occurrenceId: VALID_OCCURRENCE_ID_2,
          participants: [{ kind: 'CHILD', childId: VALID_CHILD_ID }],
        }),
      ],
    };
    expect(cartSchema.safeParse(cart).success).toBe(true);
  });

  it.each([0, -1, 100, 1.5])('rejects catalog quantity %s', (quantity) => {
    expect(cartLineSchema.safeParse(catalogLine({ quantity })).success).toBe(false);
  });

  it.each([1, 99])('accepts catalog quantity %s', (quantity) => {
    expect(cartLineSchema.safeParse(catalogLine({ quantity })).success).toBe(true);
  });
});

describe('cartSchema', () => {
  it('rejects an empty cart', () => {
    expect(cartSchema.safeParse({ lines: [] }).success).toBe(false);
  });

  it('rejects a cart with 51 lines', () => {
    const lines = Array.from({ length: 51 }, () => catalogLine());
    expect(cartSchema.safeParse({ lines }).success).toBe(false);
  });

  it('accepts a cart with 50 lines', () => {
    const lines = Array.from({ length: 50 }, () => catalogLine());
    expect(cartSchema.safeParse({ lines }).success).toBe(true);
  });
});

describe('HouseholdMemberView', () => {
  it('has a ref assignable directly to a cart participant', () => {
    const member: HouseholdMemberView = {
      ref: { kind: 'CHILD', childId: VALID_CHILD_ID } as HouseholdMemberView['ref'],
      displayName: 'Test Child',
      dateOfBirth: null,
    };
    // Compile-time assertion: HouseholdMemberView.ref must be exactly a
    // CartParticipantRef, so the picker never constructs one by hand.
    const ref: CartParticipantRef = member.ref;
    expect(ref).toBeDefined();
  });
});
