// TODO(phase-2): Credit redemption lands here. `redeemCredits` must write a
// `play_pass_ledger` entry and never mutate `play_passes.remaining_credits`
// directly — the ledger is the source of truth and that column is only a
// cache (see AGENTS.md "Data access").

import { NotImplementedInPhase1 } from '@keki/contracts';
import type { HouseholdId, LedgerReason, PlayPassId, ReservationId } from '@keki/contracts';

export async function redeemCredits(input: {
  playPassId: PlayPassId;
  credits: number;
  reservationId: ReservationId;
}): Promise<{ balance: number }> {
  void input;
  throw new NotImplementedInPhase1('redeemCredits');
}

export async function issuePass(input: {
  householdId: HouseholdId;
  totalCredits: number;
  expiresAt: Date | null;
}): Promise<{ playPassId: PlayPassId }> {
  void input;
  throw new NotImplementedInPhase1('issuePass');
}

export async function expirePass(input: {
  playPassId: PlayPassId;
  reason: LedgerReason;
}): Promise<{ balance: number }> {
  void input;
  throw new NotImplementedInPhase1('expirePass');
}
