import { z } from 'zod';
import type { CatalogItemId, ChildId, CustomerId, OccurrenceId, OfferingId } from './ids';

// ---------------------------------------------------------------------------
// Cart — the client-supplied shape a checkout consumes. Carries ids,
// participants, and quantities only. No price ever appears here: WS-05
// recomputes every amount server-side, and the schema below makes a
// client-supplied price unrepresentable rather than merely ignored.
// ---------------------------------------------------------------------------

// Mirrors the customer-XOR-child discriminated union that
// `reservation_participants` already enforces with a CHECK constraint. Do
// not introduce a third shape — the type system and the database must agree
// on this invariant.
export type CartParticipantRef =
  | { readonly kind: 'CUSTOMER'; readonly customerId: CustomerId }
  | { readonly kind: 'CHILD'; readonly childId: ChildId };

export type CartLine =
  | { readonly kind: 'CATALOG_ITEM'; readonly catalogItemId: CatalogItemId; readonly quantity: number }
  | {
      readonly kind: 'OCCURRENCE';
      readonly occurrenceId: OccurrenceId;
      // Deliberately no `quantity` field. Seat count is
      // `participants.length` — two sources for the same number would
      // eventually disagree, and the resulting overbooking would be silent.
      readonly participants: readonly CartParticipantRef[];
    };

export interface Cart {
  readonly lines: readonly CartLine[];
}

const uuidSchema = z.string().uuid();

export const cartParticipantRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('CUSTOMER'), customerId: uuidSchema }).strict(),
  z.object({ kind: z.literal('CHILD'), childId: uuidSchema }).strict(),
]);

// Structural rather than `CartParticipantRef` itself so this accepts both
// the branded form and the plain-string shape `cartParticipantRefSchema`
// infers before ids are branded — a branded id is always assignable to
// `string`, never the reverse.
type ParticipantRefLike =
  | { readonly kind: 'CUSTOMER'; readonly customerId: string }
  | { readonly kind: 'CHILD'; readonly childId: string };

// Exported so any package that renders or compares a `CartParticipantRef` —
// the household picker in @keki/ui, the review page's participant-name
// lookup, the action's duplicate/foreign-ref checks — keys it the same way
// instead of re-deriving this format at each call site.
export function cartParticipantRefKey(ref: ParticipantRefLike): string {
  return ref.kind === 'CUSTOMER' ? `CUSTOMER:${ref.customerId}` : `CHILD:${ref.childId}`;
}

const catalogItemCartLineSchema = z
  .object({
    kind: z.literal('CATALOG_ITEM'),
    catalogItemId: uuidSchema,
    quantity: z.number().int().min(1).max(99),
  })
  .strict();

const occurrenceCartLineSchema = z
  .object({
    kind: z.literal('OCCURRENCE'),
    occurrenceId: uuidSchema,
    participants: z.array(cartParticipantRefSchema).min(1).max(10),
  })
  .strict();

// `z.discriminatedUnion` requires each member to be a plain object schema,
// so the duplicate-participant check is applied with `superRefine` after the
// union is built rather than on `occurrenceCartLineSchema` directly.
export const cartLineSchema = z
  .discriminatedUnion('kind', [catalogItemCartLineSchema, occurrenceCartLineSchema])
  .superRefine((line, ctx) => {
    if (line.kind !== 'OCCURRENCE') {
      return;
    }
    const keys = line.participants.map(cartParticipantRefKey);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Duplicate participant in one occurrence line: the same person cannot occupy two seats.',
        path: ['participants'],
      });
    }
  });

export const cartSchema = z.object({
  lines: z.array(cartLineSchema).min(1).max(50),
});
export type CartInput = z.infer<typeof cartSchema>;

// ---------------------------------------------------------------------------
// Catalog view types — read shapes for the cafe menu, the class/room booking
// picker, and the household member picker.
// ---------------------------------------------------------------------------

export interface CafeItemView {
  catalogItemId: CatalogItemId;
  name: string;
  description: string | null;
  priceCents: number;
  currency: string;
}

export interface BookableOccurrenceView {
  occurrenceId: OccurrenceId;
  offeringId: OfferingId;
  name: string;
  description: string | null;
  startsAt: Date;
  endsAt: Date;
  priceCents: number;
  currency: string;
  capacity: number;
  /** Display only — stale on return. The WS-02 trigger is the real check. */
  seatsRemaining: number;
}

export interface HouseholdMemberView {
  ref: CartParticipantRef;
  displayName: string;
  dateOfBirth: Date | null;
}
