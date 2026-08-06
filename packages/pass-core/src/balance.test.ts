import { describe, expect, it, vi } from 'vitest';

// `./balance` also exports `getPassBalance`, which imports the real
// `@keki/database` client — that module resolves Neon connection strings at
// import time and throws without them. Mock it so `computeBalance` (pure, no
// I/O) stays testable without a database, per the spec.
vi.mock('@keki/database', () => ({
  db: { select: vi.fn() },
  playPassLedger: {},
}));

import { computeBalance, type LedgerEntry } from './balance';

function entry(deltaCredits: number, reason: LedgerEntry['reason'], occurredAt: string): LedgerEntry {
  return { deltaCredits, reason, occurredAt: new Date(occurredAt) };
}

describe('computeBalance', () => {
  it('sums an empty ledger to zero', () => {
    expect(computeBalance([])).toBe(0);
  });

  it('sums mixed deltas', () => {
    const entries = [
      entry(10, 'PURCHASE', '2026-01-01T00:00:00Z'),
      entry(-1, 'REDEMPTION', '2026-01-02T00:00:00Z'),
      entry(-1, 'REDEMPTION', '2026-01-03T00:00:00Z'),
      entry(2, 'ADJUSTMENT', '2026-01-04T00:00:00Z'),
    ];

    expect(computeBalance(entries)).toBe(10);
  });

  it('handles a negative result rather than clamping to zero', () => {
    const entries = [entry(1, 'PURCHASE', '2026-01-01T00:00:00Z'), entry(-3, 'REDEMPTION', '2026-01-02T00:00:00Z')];

    expect(computeBalance(entries)).toBe(-2);
  });

  it('is order-independent for a sum', () => {
    const entries = [
      entry(10, 'PURCHASE', '2026-01-01T00:00:00Z'),
      entry(-1, 'REDEMPTION', '2026-01-02T00:00:00Z'),
      entry(-1, 'REDEMPTION', '2026-01-03T00:00:00Z'),
      entry(2, 'ADJUSTMENT', '2026-01-04T00:00:00Z'),
    ];
    const shuffled = [entries[3]!, entries[0]!, entries[2]!, entries[1]!];

    expect(computeBalance(shuffled)).toBe(computeBalance(entries));
  });

  it('is pure — does not mutate the input array', () => {
    const entries = [entry(10, 'PURCHASE', '2026-01-01T00:00:00Z'), entry(-1, 'REDEMPTION', '2026-01-02T00:00:00Z')];
    const before = structuredClone(entries);

    computeBalance(entries);

    expect(entries).toEqual(before);
  });
});
