import { pgEnum } from 'drizzle-orm/pg-core';
import {
  CATALOG_ITEM_STATUSES,
  LEDGER_REASONS,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_STATUSES,
  OCCURRENCE_STATUSES,
  OFFERING_STATUSES,
  OFFERING_TYPES,
  ORDER_LINE_ITEM_KINDS,
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  RESERVATION_STATUSES,
  ROLES,
  WAIVER_STATUSES,
} from '@keki/contracts';

export const roleEnum = pgEnum('role', ROLES);
export const offeringTypeEnum = pgEnum('offering_type', OFFERING_TYPES);
export const offeringStatusEnum = pgEnum('offering_status', OFFERING_STATUSES);
export const occurrenceStatusEnum = pgEnum('occurrence_status', OCCURRENCE_STATUSES);
export const reservationStatusEnum = pgEnum('reservation_status', RESERVATION_STATUSES);
export const ledgerReasonEnum = pgEnum('ledger_reason', LEDGER_REASONS);
export const paymentStatusEnum = pgEnum('payment_status', PAYMENT_STATUSES);
export const notificationChannelEnum = pgEnum('notification_channel', NOTIFICATION_CHANNELS);
export const notificationStatusEnum = pgEnum('notification_status', NOTIFICATION_STATUSES);
export const waiverStatusEnum = pgEnum('waiver_status', WAIVER_STATUSES);
export const orderStatusEnum = pgEnum('order_status', ORDER_STATUSES);
export const orderLineItemKindEnum = pgEnum('order_line_item_kind', ORDER_LINE_ITEM_KINDS);
export const catalogItemStatusEnum = pgEnum('catalog_item_status', CATALOG_ITEM_STATUSES);
