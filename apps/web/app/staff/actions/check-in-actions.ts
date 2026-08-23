'use server';

import { revalidatePath } from 'next/cache';
import { checkInParticipant, markReservationNoShow, undoCheckInParticipant } from '@keki/staff-ops';
import {
  checkInParticipantSchema,
  createReservationId,
  createReservationParticipantId,
  markNoShowSchema,
  undoCheckInParticipantSchema,
  type ReservationId,
  type ReservationParticipantId,
  type ReservationStatus,
} from '@keki/contracts';
import { authenticatedAction } from '../../actions/authenticated-action';

// Checking a group in changes the arrived count on /staff/today and the
// headcount on /staff/occupancy; a staff member who checks someone in and
// then walks to either screen should see it reflected. Both pages are
// already dynamic, so this is belt and braces rather than strictly required.
function revalidateStaffSurfaces(): void {
  revalidatePath('/staff/today');
  revalidatePath('/staff/check-in');
  revalidatePath('/staff/occupancy');
}

export const checkInParticipantAction = authenticatedAction({
  schema: checkInParticipantSchema,
  requiredRole: 'FRONT_OF_HOUSE',
  async handler(
    input,
    session,
  ): Promise<{
    participantId: ReservationParticipantId;
    reservationId: ReservationId;
    checkedInAt: Date;
    reservationStatus: ReservationStatus;
    changed: boolean;
  }> {
    const result = await checkInParticipant({
      reservationParticipantId: createReservationParticipantId(input.reservationParticipantId),
      // Never taken from the payload — the audit trail is only as
      // trustworthy as this. `now` is also never passed here: the command
      // defaults it from the server clock, and exposing it would let a
      // caller backdate an attendance record through an action a browser
      // can invoke directly.
      actorCustomerId: session.profile.customerId,
    });
    revalidateStaffSurfaces();
    return result;
  },
});

export const undoCheckInParticipantAction = authenticatedAction({
  schema: undoCheckInParticipantSchema,
  requiredRole: 'FRONT_OF_HOUSE',
  async handler(
    input,
    session,
  ): Promise<{
    reservationId: ReservationId;
    reservationStatus: ReservationStatus;
    changed: boolean;
  }> {
    const result = await undoCheckInParticipant({
      reservationParticipantId: createReservationParticipantId(input.reservationParticipantId),
      actorCustomerId: session.profile.customerId,
    });
    revalidateStaffSurfaces();
    return result;
  },
});

export const markNoShowAction = authenticatedAction({
  schema: markNoShowSchema,
  requiredRole: 'FRONT_OF_HOUSE',
  async handler(input, session): Promise<{ reservationId: ReservationId; changed: boolean }> {
    const result = await markReservationNoShow({
      reservationId: createReservationId(input.reservationId),
      actorCustomerId: session.profile.customerId,
    });
    revalidateStaffSurfaces();
    return result;
  },
});
