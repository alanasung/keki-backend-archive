import {
  CatalogItemNotFoundError,
  CatalogItemUnavailableError,
  InvalidOrderTransitionError,
  OccurrenceNotBookableError,
  ParticipantNotInHouseholdError,
} from '@keki/commerce-core';
import { CapacityExceededError, InvalidReservationTransitionError } from '@keki/reservation-core';
import { SquareApiError } from '@keki/square-client';
import type { ActionError } from './action-result';

const GENERIC_INTERNAL_MESSAGE = 'Something went wrong. Please try again.';

/**
 * Translates a thrown domain error into a customer-safe envelope. Never put
 * an unrecognized error's message into the envelope: an unmapped error can
 * carry a connection string or a raw Square error body, and the envelope
 * crosses to the browser. The real error is logged server-side instead.
 */
export function toActionError(error: unknown): ActionError {
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

  console.error(error);
  return { code: 'INTERNAL', message: GENERIC_INTERNAL_MESSAGE };
}
