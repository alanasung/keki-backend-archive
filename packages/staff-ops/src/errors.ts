import type { ReservationId, ReservationParticipantId, ReservationStatus } from '@keki/contracts';

export class ReservationParticipantNotFoundError extends Error {
  readonly kind = 'ReservationParticipantNotFoundError';
  readonly reservationParticipantId: ReservationParticipantId;

  constructor(reservationParticipantId: ReservationParticipantId) {
    super(`No reservation participant with id "${reservationParticipantId}".`);
    this.name = 'ReservationParticipantNotFoundError';
    this.reservationParticipantId = reservationParticipantId;
  }
}

export class ReservationNotFoundError extends Error {
  readonly kind = 'ReservationNotFoundError';
  readonly reservationId: ReservationId;

  constructor(reservationId: ReservationId) {
    super(`No reservation with id "${reservationId}".`);
    this.name = 'ReservationNotFoundError';
    this.reservationId = reservationId;
  }
}

// Carries the current status so the UI can say *why*: "this booking is
// still an unfinished checkout" is actionable, "cannot check in" is not.
export class ReservationNotCheckInEligibleError extends Error {
  readonly kind = 'ReservationNotCheckInEligibleError';
  readonly reservationId: ReservationId;
  readonly status: ReservationStatus;

  constructor(reservationId: ReservationId, status: ReservationStatus) {
    super(`Reservation "${reservationId}" is ${status} and cannot be checked in.`);
    this.name = 'ReservationNotCheckInEligibleError';
    this.reservationId = reservationId;
    this.status = status;
  }
}

export class InvalidReservationTransitionError extends Error {
  readonly kind = 'InvalidReservationTransitionError';
  readonly reservationId: ReservationId;
  readonly fromStatus: ReservationStatus;
  readonly toStatus: ReservationStatus;

  constructor(reservationId: ReservationId, fromStatus: ReservationStatus, toStatus: ReservationStatus) {
    super(`Reservation "${reservationId}" cannot move from ${fromStatus} to ${toStatus}.`);
    this.name = 'InvalidReservationTransitionError';
    this.reservationId = reservationId;
    this.fromStatus = fromStatus;
    this.toStatus = toStatus;
  }
}
