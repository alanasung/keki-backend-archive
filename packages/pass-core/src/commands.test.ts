import { describe, expect, it } from 'vitest';
import { createHouseholdId, createPlayPassId, createReservationId } from '@keki/contracts';
import { expirePass, issuePass, redeemCredits } from './commands';

const playPassId = createPlayPassId('11111111-1111-4111-8111-111111111111');
const householdId = createHouseholdId('22222222-2222-4222-8222-222222222222');
const reservationId = createReservationId('33333333-3333-4333-8333-333333333333');

describe('deferred pass commands', () => {
  const cases: Array<[string, () => Promise<unknown>]> = [
    ['redeemCredits', () => redeemCredits({ playPassId, credits: 1, reservationId })],
    ['issuePass', () => issuePass({ householdId, totalCredits: 10, expiresAt: null })],
    ['expirePass', () => expirePass({ playPassId, reason: 'EXPIRY' })],
  ];

  it.each(cases)('%s throws NotImplementedInPhase1', async (_name, run) => {
    await expect(run()).rejects.toMatchObject({ kind: 'NotImplementedInPhase1' });
  });
});
