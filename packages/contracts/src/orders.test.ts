import { describe, expect, it } from 'vitest';
import { ORDER_STATUSES } from './entities';
import { ORDER_TRANSITIONS, canTransition } from './orders';

describe('canTransition', () => {
  it('permits a declared edge', () => {
    expect(canTransition('DRAFT', 'AWAITING_PAYMENT')).toBe(true);
  });

  it('rejects an edge that skips a state', () => {
    expect(canTransition('DRAFT', 'PAID')).toBe(false);
  });

  it.each(['PAID', 'CANCELLED', 'EXPIRED'] as const)(
    'treats %s as terminal, with no outbound transitions',
    (status) => {
      expect(ORDER_TRANSITIONS[status]).toEqual([]);
    },
  );

  it('covers every declared order status', () => {
    expect(Object.keys(ORDER_TRANSITIONS).sort()).toEqual([...ORDER_STATUSES].sort());
  });
});
