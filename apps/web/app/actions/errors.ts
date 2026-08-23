import {
  CatalogItemNotFoundError,
  CatalogItemUnavailableError,
  InvalidOrderTransitionError,
  OccurrenceNotBookableError,
  ParticipantNotInHouseholdError,
} from '@keki/commerce-core';
import { CapacityExceededError, InvalidReservationTransitionError } from '@keki/reservation-core';
import { SquareApiError } from '@keki/square-client';
import {
  InvalidOccurrenceTransitionError,
  InvalidOfferingTransitionError,
  OccurrenceHasReservationsError,
  OccurrenceInPastError,
  OccurrenceNotFoundError,
  OfferingNotFoundError,
  OfferingNotPublishedError,
  OverlappingOccurrenceError,
  UnsupportedOfferingTypeError,
} from '@keki/catalog-admin';
// Aliased: staff-ops declares its own ReservationNotFoundError and
// InvalidReservationTransitionError, distinct classes from reservation-core's
// same-named ones (checkout's confirmReservation/cancelReservation vs.
// WS-03's check-in commands) — an unaliased import would collide, and an
// `instanceof` check against the wrong class would silently never match.
import {
  InvalidReservationTransitionError as StaffInvalidReservationTransitionError,
  ReservationNotCheckInEligibleError,
  ReservationNotFoundError as StaffReservationNotFoundError,
  ReservationParticipantNotFoundError,
} from '@keki/staff-ops';
import type { CartParticipantRef } from '@keki/contracts';
import type { ActionError } from './action-result';

const GENERIC_INTERNAL_MESSAGE = 'Something went wrong. Please try again.';

/**
 * Thrown by checkoutAction (WS-13) when the cart cookie carries zero lines.
 * The cookie's own schema forbids an empty cart (see cart-cookie.ts), so
 * this only fires for the sentinel EMPTY_CART a missing or invalid cookie
 * resolves to — never for a cart that ever reached the cookie's signature
 * check.
 */
export class EmptyCartError extends Error {
  constructor() {
    super('Your cart is empty.');
    this.name = 'EmptyCartError';
  }
}

/**
 * Thrown by checkoutAction (WS-13) when createOrder's authoritative
 * household check rejects a participant that passed WS-09's cart-time
 * check — meaning household membership changed after the item was added to
 * the cart. Deliberately distinct from ParticipantNotInHouseholdError
 * (which WS-09's own cart actions throw, mapped to VALIDATION below as an
 * input mistake): at checkout time the same condition means the cart went
 * stale, the same category as CatalogItemUnavailableError and
 * OccurrenceNotBookableError, so it maps to CONFLICT instead.
 */
export class StaleCartParticipantError extends Error {
  readonly participant: CartParticipantRef;

  constructor(participant: CartParticipantRef) {
    super('One of the selected participants is no longer part of your household.');
    this.name = 'StaleCartParticipantError';
    this.participant = participant;
  }
}

/**
 * Translates a thrown domain error into a customer-safe envelope. Never put
 * an unrecognized error's message into the envelope: an unmapped error can
 * carry a connection string or a raw Square error body, and the envelope
 * crosses to the browser. The real error is logged server-side instead.
 */
export function toActionError(error: unknown): ActionError {
  if (error instanceof EmptyCartError) {
    return { code: 'VALIDATION', message: error.message };
  }

  if (error instanceof StaleCartParticipantError) {
    return { code: 'CONFLICT', message: error.message };
  }

  if (error instanceof CapacityExceededError) {
    return { code: 'CONFLICT', message: 'That class just sold out.' };
  }

  if (error instanceof CatalogItemUnavailableError || error instanceof CatalogItemNotFoundError) {
    return { code: 'CONFLICT', message: 'An item in your cart is no longer available.' };
  }

  if (error instanceof OccurrenceNotBookableError) {
    return { code: 'CONFLICT', message: 'That class is no longer open for booking.' };
  }

  // SC-18's usability layer (WS-09's cart actions re-check this before
  // WS-05's createOrder does): a customer picking a name outside their own
  // household is a validation mistake from the caller's perspective, not a
  // server fault, so this maps to VALIDATION rather than the generic
  // INTERNAL fallback below.
  if (error instanceof ParticipantNotInHouseholdError) {
    return { code: 'VALIDATION', message: 'One of the selected participants is not part of your household.' };
  }

  if (error instanceof InvalidOrderTransitionError || error instanceof InvalidReservationTransitionError) {
    return { code: 'CONFLICT', message: 'That action can no longer be completed.' };
  }

  if (error instanceof SquareApiError) {
    return { code: 'UNAVAILABLE', message: 'Checkout is temporarily unavailable.' };
  }

  // WS-05's admin actions (offering-actions.ts, occurrence-actions.ts): each
  // message already names the states, count, or conflicting time a manager
  // needs to act, so it is surfaced verbatim rather than replaced with a
  // generic one.
  if (error instanceof InvalidOfferingTransitionError || error instanceof InvalidOccurrenceTransitionError) {
    return { code: 'CONFLICT', message: error.message };
  }

  if (error instanceof OccurrenceHasReservationsError) {
    return { code: 'CONFLICT', message: error.message };
  }

  if (error instanceof OverlappingOccurrenceError) {
    return { code: 'CONFLICT', message: error.message };
  }

  if (error instanceof OfferingNotPublishedError) {
    return { code: 'CONFLICT', message: error.message };
  }

  if (error instanceof OccurrenceInPastError) {
    return { code: 'VALIDATION', message: error.message };
  }

  if (
    error instanceof OfferingNotFoundError ||
    error instanceof OccurrenceNotFoundError ||
    error instanceof UnsupportedOfferingTypeError
  ) {
    return { code: 'VALIDATION', message: error.message };
  }

  // WS-05's staff check-in actions: each message already names the current
  // status or both sides of the refused transition, which is what makes the
  // refusal actionable for a staff member — "this booking is still an
  // unfinished checkout" rather than "cannot check in".
  if (
    error instanceof ReservationNotCheckInEligibleError ||
    error instanceof StaffInvalidReservationTransitionError
  ) {
    return { code: 'CONFLICT', message: error.message };
  }

  if (error instanceof ReservationParticipantNotFoundError || error instanceof StaffReservationNotFoundError) {
    return { code: 'VALIDATION', message: error.message };
  }

  console.error(error);
  return { code: 'INTERNAL', message: GENERIC_INTERNAL_MESSAGE };
}
