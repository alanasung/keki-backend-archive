import {
  CatalogItemNotFoundError,
  CatalogItemUnavailableError,
  InvalidOrderTransitionError,
  OccurrenceNotBookableError,
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

  if (error instanceof InvalidOrderTransitionError || error instanceof InvalidReservationTransitionError) {
    return { code: 'CONFLICT', message: 'That action can no longer be completed.' };
  }

  if (error instanceof SquareApiError) {
    return { code: 'UNAVAILABLE', message: 'Checkout is temporarily unavailable.' };
  }

  console.error(error);
  return { code: 'INTERNAL', message: GENERIC_INTERNAL_MESSAGE };
}
