import { asc, eq } from 'drizzle-orm';
import { db, playPassLedger } from '@keki/database';
import type { LedgerReason, PlayPassId } from '@keki/contracts';

export interface LedgerEntry {
  readonly deltaCredits: number;
  readonly reason: LedgerReason;
  readonly occurredAt: Date;
}

/** Sums deltas in chronological order. Pure — no I/O. */
export function computeBalance(entries: readonly LedgerEntry[]): number {
  return entries.reduce((total, entry) => total + entry.deltaCredits, 0);
}

/** Loads the ledger for a pass and folds it. */
export async function getPassBalance(playPassId: PlayPassId): Promise<number> {
  const rows = await db
    .select({
      deltaCredits: playPassLedger.deltaCredits,
      reason: playPassLedger.reason,
      occurredAt: playPassLedger.occurredAt,
    })
    .from(playPassLedger)
    .where(eq(playPassLedger.playPassId, playPassId))
    .orderBy(asc(playPassLedger.occurredAt));

  return computeBalance(rows);
}
