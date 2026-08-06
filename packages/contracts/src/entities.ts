import { z } from 'zod';
import type {
  ChildId,
  CustomerId,
  HouseholdId,
  NotificationOutboxEntryId,
  OccurrenceId,
  OfferingId,
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

export interface Offering {
  id: OfferingId;
  type: OfferingType;
  status: OfferingStatus;
  name: string;
  description: string | null;
  capacity: number;
  priceCents: number;
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
