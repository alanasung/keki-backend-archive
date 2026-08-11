import {
  CatalogItemNotFoundError,
  CatalogItemUnavailableError,
  InvalidOrderTransitionError,
  OccurrenceNotBookableError,
} from '@keki/commerce-core';
import { createCatalogItemId, createOccurrenceId, createOrderId, createReservationId } from '@keki/contracts';
import { CapacityExceededError, InvalidReservationTransitionError } from '@keki/reservation-core';
import { SquareApiError } from '@keki/square-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toActionError } from './errors';

const FIXTURE_OCCURRENCE_ID = createOccurrenceId('11111111-1111-4111-8111-111111111111');
const FIXTURE_CATALOG_ITEM_ID = createCatalogItemId('22222222-2222-4222-8222-222222222222');
const FIXTURE_ORDER_ID = createOrderId('33333333-3333-4333-8333-333333333333');
const FIXTURE_RESERVATION_ID = createReservationId('44444444-4444-4444-8444-444444444444');

describe('toActionError', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Test 11
  it('maps CapacityExceededError to CONFLICT', () => {
    const error = new CapacityExceededError(FIXTURE_OCCURRENCE_ID, 2);
    expect(toActionError(error)).toEqual({ code: 'CONFLICT', message: 'That class just sold out.' });
  });

  it('maps CatalogItemUnavailableError to CONFLICT', () => {
    const error = new CatalogItemUnavailableError(FIXTURE_CATALOG_ITEM_ID);
    expect(toActionError(error)).toEqual({
      code: 'CONFLICT',
      message: 'An item in your cart is no longer available.',
    });
  });

  it('maps CatalogItemNotFoundError to CONFLICT', () => {
    const error = new CatalogItemNotFoundError(FIXTURE_CATALOG_ITEM_ID);
    expect(toActionError(error).code).toBe('CONFLICT');
  });

  it('maps OccurrenceNotBookableError to CONFLICT', () => {
    const error = new OccurrenceNotBookableError(FIXTURE_OCCURRENCE_ID);
    expect(toActionError(error).code).toBe('CONFLICT');
  });

  it('maps InvalidOrderTransitionError to CONFLICT', () => {
    const error = new InvalidOrderTransitionError(FIXTURE_ORDER_ID, 'DRAFT', 'AWAITING_PAYMENT');
    expect(toActionError(error).code).toBe('CONFLICT');
  });

  it('maps InvalidReservationTransitionError to CONFLICT', () => {
    const error = new InvalidReservationTransitionError(FIXTURE_RESERVATION_ID, 'HELD', 'CONFIRMED');
    expect(toActionError(error).code).toBe('CONFLICT');
  });

  // Test 11
  it('maps SquareApiError to UNAVAILABLE', () => {
    const error = new SquareApiError('createCheckout', new Error('boom'));
    expect(toActionError(error)).toEqual({
      code: 'UNAVAILABLE',
      message: 'Checkout is temporarily unavailable.',
    });
  });

  // Test 12
  it('returns a generic message for an unmapped error and never leaks the original text', () => {
    const secret = 'postgres://user:password@host/db';
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = toActionError(new Error(secret));

    expect(result.code).toBe('INTERNAL');
    expect(result.message).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  // Test 13
  it('logs the original error server-side for an unmapped error', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error('unexpected failure');

    toActionError(error);

    expect(consoleErrorSpy).toHaveBeenCalledWith(error);
  });
});
