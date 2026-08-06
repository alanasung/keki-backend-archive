import { describe, expect, it } from 'vitest';
import {
  createHouseholdId,
  createOccurrenceId,
  createReservationId,
} from '@keki/contracts';
import { cancelReservation, confirmReservation, holdReservation } from './commands';

const occurrenceId = createOccurrenceId('11111111-1111-4111-8111-111111111111');
const householdId = createHouseholdId('22222222-2222-4222-8222-222222222222');
const reservationId = createReservationId('33333333-3333-4333-8333-333333333333');

describe('deferred reservation commands', () => {
  const cases: Array<[string, () => Promise<unknown>]> = [
    ['holdReservation', () => holdReservation({ occurrenceId, householdId, participants: [] })],
    ['confirmReservation', () => confirmReservation({ reservationId })],
    ['cancelReservation', () => cancelReservation({ reservationId, reason: 'test' })],
  ];

  it.each(cases)('%s throws NotImplementedInPhase1', async (_name, run) => {
    await expect(run()).rejects.toMatchObject({ kind: 'NotImplementedInPhase1' });
  });
});
