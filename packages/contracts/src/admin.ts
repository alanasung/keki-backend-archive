import { z } from 'zod';
import type { CustomerId, StaffAuditLogEntryId } from './ids';
import type { OccurrenceStatus, OfferingStatus } from './entities';

// ---------------------------------------------------------------------------
// Transition tables — expressed as data rather than scattered conditionals,
// mirroring ORDER_TRANSITIONS in ./orders. The `Record<Status, ...>`
// annotation forces every status to have an entry — a missing one is a type
// error, not a silent gap.
// ---------------------------------------------------------------------------

// PUBLISHED -> DRAFT is permitted deliberately: unpublishing is how staff
// pull a class off sale without destroying it, and createOrder already
// re-validates that an offering is published, so a customer mid-checkout
// fails cleanly rather than buying an unpublished class. ARCHIVED is
// terminal — un-archiving would let a slug and price return to sale long
// after anyone remembers why it was retired; re-creating is the deliberate
// path.
export const OFFERING_TRANSITIONS: Readonly<Record<OfferingStatus, readonly OfferingStatus[]>> = {
  DRAFT: ['PUBLISHED', 'ARCHIVED'],
  PUBLISHED: ['DRAFT', 'ARCHIVED'],
  ARCHIVED: [],
} as const;

export function canTransitionOffering(from: OfferingStatus, to: OfferingStatus): boolean {
  return OFFERING_TRANSITIONS[from].includes(to);
}

export const OCCURRENCE_TRANSITIONS: Readonly<
  Record<OccurrenceStatus, readonly OccurrenceStatus[]>
> = {
  SCHEDULED: ['CANCELLED', 'COMPLETED'],
  CANCELLED: [],
  COMPLETED: [],
} as const;

export function canTransitionOccurrence(from: OccurrenceStatus, to: OccurrenceStatus): boolean {
  return OCCURRENCE_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Admin input schemas — strict parsing so an unknown key fails loudly rather
// than being silently dropped. Each omission below is deliberate; see the
// workstream spec for the reasoning.
// ---------------------------------------------------------------------------

export const createOfferingSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).nullable(),
    type: z.literal('CLASS'),
    durationMinutes: z.number().int().min(5).max(600),
    defaultCapacity: z.number().int().min(1).max(500),
    priceCents: z.number().int().min(0).max(10_000_00),
    currency: z.string().length(3).default('USD'),
  })
  .strict();

export type CreateOfferingInput = z.infer<typeof createOfferingSchema>;

export const updateOfferingSchema = createOfferingSchema.partial().strict();
export type UpdateOfferingInput = z.infer<typeof updateOfferingSchema>;

export const scheduleOccurrenceSchema = z
  .object({
    offeringId: z.string().uuid(),
    startsAt: z.coerce.date(),
    capacityOverride: z.number().int().min(1).max(500).nullable(),
  })
  .strict();

export type ScheduleOccurrenceInput = z.infer<typeof scheduleOccurrenceSchema>;

export const updateOccurrenceSchema = z
  .object({
    startsAt: z.coerce.date().optional(),
    capacityOverride: z.number().int().min(1).max(500).nullable().optional(),
  })
  .strict();

export type UpdateOccurrenceInput = z.infer<typeof updateOccurrenceSchema>;

// ---------------------------------------------------------------------------
// Audit vocabulary — actions are a closed set rather than free text so a
// reader can enumerate what is auditable, and so a typo becomes a compile
// error instead of an entry nobody will ever find.
// ---------------------------------------------------------------------------

export const AUDIT_ACTIONS = [
  'offering.created',
  'offering.updated',
  'offering.published',
  'offering.unpublished',
  'offering.archived',
  'occurrence.scheduled',
  'occurrence.updated',
  'occurrence.cancelled',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_ENTITY_TYPES = ['offering', 'occurrence'] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

export interface AuditEntry {
  readonly id: StaffAuditLogEntryId;
  readonly actorCustomerId: CustomerId;
  readonly action: AuditAction;
  readonly entityType: AuditEntityType;
  readonly entityId: string;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly occurredAt: Date;
}
