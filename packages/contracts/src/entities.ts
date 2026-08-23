import { z } from 'zod';
import type {
  CatalogItemId,
  ChildId,
  CustomerId,
  HouseholdId,
  NotificationOutboxEntryId,
  OccurrenceId,
  OfferingId,
  OrderId,
  OrderLineItemId,
  PaymentRecordId,
  PlayPassId,
  PlayPassLedgerEntryId,
  ReservationId,
  ReservationParticipantId,
  StaffAuditLogEntryId,
  WaiverRecordId,
} from './ids';

// ---------------------------------------------------------------------------
// Enums — declared as a const tuple plus a derived union, mirroring ROLES, so
// WS-03 can reuse the tuples directly as Postgres enum values.
// ---------------------------------------------------------------------------

// Occurrence times render in the cafe's timezone — `occurrences.starts_at`
// is stored as `timestamptz` specifically so a class scheduled across a DST
// boundary still shows the right local hour (see
// packages/database/src/schema/catalog.ts). Rendering in the server's zone
// or in UTC would show customers the wrong time twice a year, so every
// formatter that renders an occurrence is pinned to this single named
// constant. Domain packages compute the cafe's day boundaries from it too —
// WS-04's "today's schedule" query groups by this zone, not the server's.
// Exported so /book and /admin/schedules render the same class at the same
// local hour instead of each declaring a constant that could drift.
export const CAFE_TIME_ZONE = 'America/Los_Angeles';

export const OFFERING_TYPES = ['CLASS', 'ROOM', 'OPEN_PLAY'] as const;
export type OfferingType = (typeof OFFERING_TYPES)[number];

export const OFFERING_STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;
export type OfferingStatus = (typeof OFFERING_STATUSES)[number];

export const OCCURRENCE_STATUSES = ['SCHEDULED', 'CANCELLED', 'COMPLETED'] as const;
export type OccurrenceStatus = (typeof OCCURRENCE_STATUSES)[number];

export const RESERVATION_STATUSES = [
  'HELD',
  'CONFIRMED',
  'CHECKED_IN',
  'CANCELLED',
  'NO_SHOW',
] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

/**
 * The reservation statuses that occupy a seat.
 *
 * This is the single authority for a rule four call sites previously each
 * declared for themselves: the capacity trigger
 * (`drizzle/0002_capacity_constraint.sql`), `catalog-core`'s `seatsRemaining`,
 * `reservation-core`'s seat accounting, and `catalog-admin`'s `bookedSeats`.
 * They must agree exactly — if one drifts, a surface advertises seats the
 * database refuses, or hides seats that are actually free.
 *
 * The trigger is raw SQL and cannot import this constant, so
 * `schema.test.ts` asserts the two match rather than trusting the comment.
 */
export const SEAT_CONSUMING_STATUSES = ['HELD', 'CONFIRMED', 'CHECKED_IN'] as const;
export type SeatConsumingStatus = (typeof SEAT_CONSUMING_STATUSES)[number];

export const LEDGER_REASONS = ['PURCHASE', 'REDEMPTION', 'ADJUSTMENT', 'EXPIRY', 'REFUND'] as const;
export type LedgerReason = (typeof LEDGER_REASONS)[number];

export const PAYMENT_STATUSES = [
  'PENDING',
  'AUTHORIZED',
  'CAPTURED',
  'REFUNDED',
  'FAILED',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const NOTIFICATION_CHANNELS = ['EMAIL', 'SMS', 'MARKETING'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

// CLAIMED is a non-terminal lease state, not a synonym for "sent". A worker
// moves a row PENDING -> CLAIMED when it takes ownership, then CLAIMED -> SENT
// on success or CLAIMED -> PENDING/DEAD on failure. WS-03 pairs it with
// claimed_at/claimed_by columns and WS-07 implements the transitions.
export const NOTIFICATION_STATUSES = ['PENDING', 'CLAIMED', 'SENT', 'FAILED', 'DEAD'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export const WAIVER_STATUSES = ['SIGNED', 'EXPIRED', 'REVOKED'] as const;
export type WaiverStatus = (typeof WAIVER_STATUSES)[number];

export const ORDER_STATUSES = ['DRAFT', 'AWAITING_PAYMENT', 'PAID', 'CANCELLED', 'EXPIRED'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_LINE_ITEM_KINDS = ['CATALOG_ITEM', 'OCCURRENCE'] as const;
export type OrderLineItemKind = (typeof ORDER_LINE_ITEM_KINDS)[number];

export const CATALOG_ITEM_STATUSES = ['ACTIVE', 'ARCHIVED'] as const;
export type CatalogItemStatus = (typeof CATALOG_ITEM_STATUSES)[number];

// ---------------------------------------------------------------------------
// Entity types — shared shapes; WS-03 derives the Drizzle tables to match.
// Branded IDs for all keys, `Date` for timestamps, integer minor units
// (`amountCents`) for money.
// ---------------------------------------------------------------------------

export interface Household {
  id: HouseholdId;
  primaryCustomerId: CustomerId;
  createdAt: Date;
  updatedAt: Date;
}

export interface Customer {
  id: CustomerId;
  householdId: HouseholdId;
  cognitoSub: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Child {
  id: ChildId;
  householdId: HouseholdId;
  firstName: string;
  lastName: string;
  dateOfBirth: Date;
  createdAt: Date;
  updatedAt: Date;
}

// Mirrors packages/database/src/schema/catalog.ts's `offerings` table
// exactly. WS-02 (catalog-admin) is the first writer and returns every
// persisted column; the slimmer shape this predates (no slug/duration/
// currency, `capacity` rather than `defaultCapacity`) had no reader to break.
export interface Offering {
  id: OfferingId;
  slug: string;
  type: OfferingType;
  status: OfferingStatus;
  name: string;
  description: string | null;
  durationMinutes: number;
  defaultCapacity: number;
  priceCents: number;
  currency: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Occurrence {
  id: OccurrenceId;
  offeringId: OfferingId;
  status: OccurrenceStatus;
  startsAt: Date;
  endsAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface Reservation {
  id: ReservationId;
  occurrenceId: OccurrenceId;
  customerId: CustomerId;
  status: ReservationStatus;
  holdExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface ReservationParticipantBase {
  id: ReservationParticipantId;
  reservationId: ReservationId;
  createdAt: Date;
}

// Exactly one of customerId or childId is set. Expressed as a discriminated
// union — via the optional-never pattern — rather than two optional fields,
// so the impossible state (both, or neither) is unrepresentable.
export type ReservationParticipant = ReservationParticipantBase &
  ({ customerId: CustomerId; childId?: never } | { childId: ChildId; customerId?: never });

export interface PlayPass {
  id: PlayPassId;
  householdId: HouseholdId;
  totalCredits: number;
  remainingCredits: number;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PlayPassLedgerEntry {
  id: PlayPassLedgerEntryId;
  playPassId: PlayPassId;
  reason: LedgerReason;
  creditsDelta: number;
  reservationId: ReservationId | null;
  createdAt: Date;
}

export interface WaiverRecord {
  id: WaiverRecordId;
  householdId: HouseholdId;
  participantName: string;
  status: WaiverStatus;
  providerReference: string;
  signedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PaymentRecord {
  id: PaymentRecordId;
  reservationId: ReservationId | null;
  status: PaymentStatus;
  amountCents: number;
  currency: string;
  providerPaymentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CatalogItem {
  id: CatalogItemId;
  squareCatalogObjectId: string;
  squareVariationId: string;
  name: string;
  description: string | null;
  priceCents: number;
  currency: string;
  status: CatalogItemStatus;
  syncedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface Order {
  id: OrderId;
  householdId: HouseholdId;
  createdByCustomerId: CustomerId;
  status: OrderStatus;
  // "Subtotal", never "total" — Square owns tax and computes the
  // authoritative charge. A field named totalCents would invite treating
  // this number as the amount charged.
  subtotalCents: number;
  currency: string;
  squareOrderId: string | null;
  squareCheckoutUrl: string | null;
  providerPaymentId: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrderLineItem {
  id: OrderLineItemId;
  orderId: OrderId;
  kind: OrderLineItemKind;
  catalogItemId: CatalogItemId | null;
  occurrenceId: OccurrenceId | null;
  reservationId: ReservationId | null;
  quantity: number;
  // Captured at order time, so a later catalog sync cannot retroactively
  // rewrite what a customer was charged.
  unitPriceCents: number;
  nameSnapshot: string;
}

export interface NotificationOutboxEntry {
  id: NotificationOutboxEntryId;
  customerId: CustomerId;
  channel: NotificationChannel;
  status: NotificationStatus;
  templateKey: string;
  payload: Record<string, unknown>;
  claimedAt: Date | null;
  claimedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface StaffAuditLogEntry {
  id: StaffAuditLogEntryId;
  actorCustomerId: CustomerId;
  action: string;
  targetEntity: string;
  targetId: string;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Zod schemas — for values that cross a trust boundary (a Server Action or
// webhook accepts them). Not a schema per entity; schemas validate input,
// they don't restate the type system.
// ---------------------------------------------------------------------------

const uuidSchema = z.string().uuid();

export const createReservationSchema = z.object({
  occurrenceId: uuidSchema,
  customerId: uuidSchema,
  participants: z
    .array(z.union([z.object({ customerId: uuidSchema }), z.object({ childId: uuidSchema })]))
    .min(1),
});
export type CreateReservationInput = z.infer<typeof createReservationSchema>;

export const registerCustomerSchema = z.object({
  householdId: uuidSchema.optional(),
  email: z.string().email(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  phone: z.string().min(1).optional(),
});
export type RegisterCustomerInput = z.infer<typeof registerCustomerSchema>;
