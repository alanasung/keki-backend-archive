import type { OccurrenceId, ReservationId, ReservationStatus } from '@keki/contracts';

// Deferral marker for Phase 1 — defined once in @keki/contracts (WS-02) and
// re-exported here so the rest of this package imports it locally.
export { NotImplementedInPhase1 } from '@keki/contracts';

// Carries the occurrence id so WS-05 can propagate it unwrapped and the UI
// can name which class sold out, and `requestedSeats` so the message (and
// any UI built on it) can say by how many.
export class CapacityExceededError extends Error {
  readonly kind = 'CapacityExceededError';
  readonly occurrenceId: OccurrenceId;
  readonly requestedSeats: number;

  constructor(occurrenceId: OccurrenceId, requestedSeats: number) {
    super(
      `Occurrence "${occurrenceId}" does not have ${requestedSeats} seat(s) remaining.`,
    );
    this.name = 'CapacityExceededError';
    this.occurrenceId = occurrenceId;
    this.requestedSeats = requestedSeats;
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

// A zero-seat hold consumes nothing and corrupts every downstream count —
// rejected before any statement is issued, not caught as a database error.
export class EmptyParticipantsError extends Error {
  readonly kind = 'EmptyParticipantsError';

  constructor() {
    super('holdReservation requires at least one participant.');
    this.name = 'EmptyParticipantsError';
  }
}
