import {
  createCatalogItemId,
  createChildId,
  createCustomerId,
  createOccurrenceId,
  type Cart,
  type CartInput,
  type CartParticipantRef,
} from '@keki/contracts';

export const EMPTY_CART: Cart = { lines: [] };

// `cartSchema.safeParse` (and the action schemas built on top of
// `cartParticipantRefSchema`) infer plain, unbranded strings for every id —
// `@keki/contracts` has no Drizzle/branding dependency at the zod-schema
// level. Everything downstream keys a `Cart` by its branded id types, so
// parsed input is normalized into branded form once, here, rather than
// scattering id-brand conversions through cart-cookie.ts and actions.ts.
// Mirrors packages/commerce-core/src/orders.ts's own toBrandedCart, which
// this package cannot import (apps/web must not reach into a core package's
// internals, and this helper isn't part of commerce-core's public surface).
type ParsedCartLine = CartInput['lines'][number];
type ParsedParticipant = Extract<ParsedCartLine, { kind: 'OCCURRENCE' }>['participants'][number];

export function toBrandedParticipant(participant: ParsedParticipant): CartParticipantRef {
  return participant.kind === 'CUSTOMER'
    ? { kind: 'CUSTOMER', customerId: createCustomerId(participant.customerId) }
    : { kind: 'CHILD', childId: createChildId(participant.childId) };
}

export function toBrandedCart(parsed: CartInput): Cart {
  return {
    lines: parsed.lines.map((line) =>
      line.kind === 'CATALOG_ITEM'
        ? {
            kind: 'CATALOG_ITEM' as const,
            catalogItemId: createCatalogItemId(line.catalogItemId),
            quantity: line.quantity,
          }
        : {
            kind: 'OCCURRENCE' as const,
            occurrenceId: createOccurrenceId(line.occurrenceId),
            participants: line.participants.map(toBrandedParticipant),
          },
    ),
  };
}
