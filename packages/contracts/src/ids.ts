declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function makeIdFactory<B extends string>(brandName: B): (value: string) => Brand<string, B> {
  return (value: string): Brand<string, B> => {
    if (!UUID_V4_RE.test(value)) {
      throw new Error(`Invalid ${brandName}: "${value}" is not a valid UUID v4 string.`);
    }
    return value as Brand<string, B>;
  };
}

export type HouseholdId = Brand<string, 'HouseholdId'>;
export const createHouseholdId = makeIdFactory<'HouseholdId'>('HouseholdId');

export type CustomerId = Brand<string, 'CustomerId'>;
export const createCustomerId = makeIdFactory<'CustomerId'>('CustomerId');

export type ChildId = Brand<string, 'ChildId'>;
export const createChildId = makeIdFactory<'ChildId'>('ChildId');

export type OfferingId = Brand<string, 'OfferingId'>;
export const createOfferingId = makeIdFactory<'OfferingId'>('OfferingId');

export type OccurrenceId = Brand<string, 'OccurrenceId'>;
export const createOccurrenceId = makeIdFactory<'OccurrenceId'>('OccurrenceId');

export type ReservationId = Brand<string, 'ReservationId'>;
export const createReservationId = makeIdFactory<'ReservationId'>('ReservationId');

export type ReservationParticipantId = Brand<string, 'ReservationParticipantId'>;
export const createReservationParticipantId = makeIdFactory<'ReservationParticipantId'>(
  'ReservationParticipantId',
);

export type PlayPassId = Brand<string, 'PlayPassId'>;
export const createPlayPassId = makeIdFactory<'PlayPassId'>('PlayPassId');

export type PlayPassLedgerEntryId = Brand<string, 'PlayPassLedgerEntryId'>;
export const createPlayPassLedgerEntryId =
  makeIdFactory<'PlayPassLedgerEntryId'>('PlayPassLedgerEntryId');

export type WaiverRecordId = Brand<string, 'WaiverRecordId'>;
export const createWaiverRecordId = makeIdFactory<'WaiverRecordId'>('WaiverRecordId');

export type PaymentRecordId = Brand<string, 'PaymentRecordId'>;
export const createPaymentRecordId = makeIdFactory<'PaymentRecordId'>('PaymentRecordId');

export type NotificationOutboxEntryId = Brand<string, 'NotificationOutboxEntryId'>;
export const createNotificationOutboxEntryId = makeIdFactory<'NotificationOutboxEntryId'>(
  'NotificationOutboxEntryId',
);

export type StaffAuditLogEntryId = Brand<string, 'StaffAuditLogEntryId'>;
export const createStaffAuditLogEntryId =
  makeIdFactory<'StaffAuditLogEntryId'>('StaffAuditLogEntryId');

export type CatalogItemId = Brand<string, 'CatalogItemId'>;
export const createCatalogItemId = makeIdFactory<'CatalogItemId'>('CatalogItemId');

export type OrderId = Brand<string, 'OrderId'>;
export const createOrderId = makeIdFactory<'OrderId'>('OrderId');

export type OrderLineItemId = Brand<string, 'OrderLineItemId'>;
export const createOrderLineItemId = makeIdFactory<'OrderLineItemId'>('OrderLineItemId');
