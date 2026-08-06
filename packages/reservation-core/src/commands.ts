// TODO(phase-2): Booking capacity rules land here. `holdReservation` is where
// the capacity check must live — it does not exist yet (see
// `docs/vision.md` § Scope: Phase 1 and the schema TODO on
// `reservations` in packages/database/src/schema/reservations.ts).
// `countConfirmedParticipants` in queries.ts reports occupancy; it does not
// enforce it, and must not be repurposed as the check.

import type {
  HouseholdId,
  OccurrenceId,
  Reservation,
  ReservationId,
  ReservationParticipant,
} from '@keki/contracts';
import { NotImplementedInPhase1 } from './errors';

export async function holdReservation(input: {
  occurrenceId: OccurrenceId;
  householdId: HouseholdId;
  participants: readonly ReservationParticipant[];
}): Promise<Reservation> {
  void input;
  throw new NotImplementedInPhase1('holdReservation');
}

export async function confirmReservation(input: {
  reservationId: ReservationId;
}): Promise<Reservation> {
  void input;
  throw new NotImplementedInPhase1('confirmReservation');
}

export async function cancelReservation(input: {
  reservationId: ReservationId;
  reason: string;
}): Promise<Reservation> {
  void input;
  throw new NotImplementedInPhase1('cancelReservation');
}
