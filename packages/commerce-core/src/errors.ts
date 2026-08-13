import type { CartParticipantRef, CatalogItemId, OccurrenceId, OrderId, OrderStatus } from '@keki/contracts';

export class CatalogItemNotFoundError extends Error {
  readonly kind = 'CatalogItemNotFoundError';
  readonly catalogItemId: CatalogItemId;

  constructor(catalogItemId: CatalogItemId) {
    super(`No catalog item with id "${catalogItemId}".`);
    this.name = 'CatalogItemNotFoundError';
    this.catalogItemId = catalogItemId;
  }
}

export class CatalogItemUnavailableError extends Error {
  readonly kind = 'CatalogItemUnavailableError';
  readonly catalogItemId: CatalogItemId;

  constructor(catalogItemId: CatalogItemId) {
    super(`Catalog item "${catalogItemId}" is archived and not available for purchase.`);
    this.name = 'CatalogItemUnavailableError';
    this.catalogItemId = catalogItemId;
  }
}

export class OccurrenceNotBookableError extends Error {
  readonly kind = 'OccurrenceNotBookableError';
  readonly occurrenceId: OccurrenceId;

  constructor(occurrenceId: OccurrenceId) {
    super(
      `Occurrence "${occurrenceId}" is not open for booking: it does not exist, its offering is not ` +
        'published, it is not SCHEDULED, or it has already started.',
    );
    this.name = 'OccurrenceNotBookableError';
    this.occurrenceId = occurrenceId;
  }
}

export class MixedCurrencyError extends Error {
  readonly kind = 'MixedCurrencyError';
  readonly currencies: readonly string[];

  constructor(currencies: readonly string[]) {
    super(`Cart lines disagree on currency: ${currencies.join(', ')}.`);
    this.name = 'MixedCurrencyError';
    this.currencies = currencies;
  }
}

// Deliberately reports no more than kind + id: this fires when a customer id
// or child id supplied by the browser does not belong to the session
// household (SC-18), and the message must not leak whether the id exists at
// all under a different household.
export class ParticipantNotInHouseholdError extends Error {
  readonly kind = 'ParticipantNotInHouseholdError';
  readonly participant: CartParticipantRef;

  constructor(participant: CartParticipantRef) {
    const id = participant.kind === 'CUSTOMER' ? participant.customerId : participant.childId;
    super(`${participant.kind} "${id}" is not a member of this household.`);
    this.name = 'ParticipantNotInHouseholdError';
    this.participant = participant;
  }
}

export class InvalidOrderTransitionError extends Error {
  readonly kind = 'InvalidOrderTransitionError';
  readonly orderId: OrderId;
  readonly fromStatus: OrderStatus;
  readonly toStatus: OrderStatus;

  constructor(orderId: OrderId, fromStatus: OrderStatus, toStatus: OrderStatus) {
    super(`Order "${orderId}" cannot move from ${fromStatus} to ${toStatus}.`);
    this.name = 'InvalidOrderTransitionError';
    this.orderId = orderId;
    this.fromStatus = fromStatus;
    this.toStatus = toStatus;
  }
}

export class OrderNotFoundError extends Error {
  readonly kind = 'OrderNotFoundError';
  readonly orderId: OrderId;

  constructor(orderId: OrderId) {
    super(`No order with id "${orderId}".`);
    this.name = 'OrderNotFoundError';
    this.orderId = orderId;
  }
}
