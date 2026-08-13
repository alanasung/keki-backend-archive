import { eq, inArray } from 'drizzle-orm';
import {
  catalogItems,
  children,
  customers,
  occurrences,
  offerings,
  orderLineItems,
  orders,
  withTransaction,
  type Tx,
} from '@keki/database';
import {
  cartSchema,
  createCatalogItemId,
  createChildId,
  createCustomerId,
  createOccurrenceId,
  type Cart,
  type CartInput,
  type CartParticipantRef,
  type CatalogItemId,
  type CustomerId,
  type HouseholdId,
  type OccurrenceId,
  type Order,
  type OrderLineItem,
  type OrderLineItemKind,
  type ReservationId,
  type SeatHolder,
} from '@keki/contracts';
import {
  CatalogItemNotFoundError,
  CatalogItemUnavailableError,
  MixedCurrencyError,
  OccurrenceNotBookableError,
  ParticipantNotInHouseholdError,
} from './errors';
import { toOrder, toOrderLineItem } from './queries';

const DEFAULT_HOLD_TTL_MINUTES = 15;

// This is SC-18, and it is a privacy control, not a validation nicety. The
// participant ids arrive from the browser: without this check, any signed-in
// customer who guesses or obtains another family's child id could book that
// child into a class, and the reservation, the check-in list, and eventually
// the waiver record would all name a child from a household that never
// consented. Do not rely on the picker only offering household members — the
// picker is UI, this is the boundary.
async function assertParticipantsInHousehold(input: {
  householdId: HouseholdId;
  participants: readonly CartParticipantRef[];
  tx: Tx;
}): Promise<void> {
  const customerIds = input.participants
    .filter(
      (participant): participant is Extract<CartParticipantRef, { kind: 'CUSTOMER' }> =>
        participant.kind === 'CUSTOMER',
    )
    .map((participant) => participant.customerId);
  const childIds = input.participants
    .filter(
      (participant): participant is Extract<CartParticipantRef, { kind: 'CHILD' }> =>
        participant.kind === 'CHILD',
    )
    .map((participant) => participant.childId);

  const [customerRows, childRows] = await Promise.all([
    customerIds.length === 0
      ? Promise.resolve([])
      : input.tx
          .select({ id: customers.id, householdId: customers.householdId })
          .from(customers)
          .where(inArray(customers.id, customerIds)),
    childIds.length === 0
      ? Promise.resolve([])
      : input.tx
          .select({ id: children.id, householdId: children.householdId })
          .from(children)
          .where(inArray(children.id, childIds)),
  ]);

  const customerHouseholds = new Map(customerRows.map((row) => [row.id, row.householdId]));
  const childHouseholds = new Map(childRows.map((row) => [row.id, row.householdId]));

  for (const participant of input.participants) {
    const actualHouseholdId =
      participant.kind === 'CUSTOMER'
        ? customerHouseholds.get(participant.customerId)
        : childHouseholds.get(participant.childId);
    if (actualHouseholdId === undefined || actualHouseholdId !== input.householdId) {
      throw new ParticipantNotInHouseholdError(participant);
    }
  }
}

interface ResolvedLine {
  readonly kind: OrderLineItemKind;
  readonly catalogItemId: CatalogItemId | null;
  readonly occurrenceId: OccurrenceId | null;
  readonly quantity: number;
  readonly unitPriceCents: number;
  readonly nameSnapshot: string;
  readonly currency: string;
  readonly participants: readonly CartParticipantRef[];
}

// The cart input contributes exactly two things: catalog quantity, and which
// people attend. Every monetary value below is read from the database — this
// is the invariant a later editor must not break.
async function resolveCartLines(cart: Cart, tx: Tx, now: Date): Promise<readonly ResolvedLine[]> {
  const resolved: ResolvedLine[] = [];

  for (const line of cart.lines) {
    if (line.kind === 'CATALOG_ITEM') {
      const catalogItemId = createCatalogItemId(line.catalogItemId);
      const rows = await tx.select().from(catalogItems).where(eq(catalogItems.id, catalogItemId)).limit(1);
      const row = rows[0];
      if (row === undefined) {
        throw new CatalogItemNotFoundError(catalogItemId);
      }
      if (row.status === 'ARCHIVED') {
        throw new CatalogItemUnavailableError(catalogItemId);
      }
      resolved.push({
        kind: 'CATALOG_ITEM',
        catalogItemId,
        occurrenceId: null,
        quantity: line.quantity,
        unitPriceCents: row.priceCents,
        nameSnapshot: row.name,
        currency: row.currency,
        participants: [],
      });
      continue;
    }

    const occurrenceId = createOccurrenceId(line.occurrenceId);
    const rows = await tx
      .select({
        occurrenceStatus: occurrences.status,
        startsAt: occurrences.startsAt,
        offeringStatus: offerings.status,
        name: offerings.name,
        priceCents: offerings.priceCents,
        currency: offerings.currency,
      })
      .from(occurrences)
      .innerJoin(offerings, eq(occurrences.offeringId, offerings.id))
      .where(eq(occurrences.id, occurrenceId))
      .limit(1);
    const row = rows[0];
    if (
      row === undefined ||
      row.offeringStatus !== 'PUBLISHED' ||
      row.occurrenceStatus !== 'SCHEDULED' ||
      row.startsAt.getTime() <= now.getTime()
    ) {
      throw new OccurrenceNotBookableError(occurrenceId);
    }
    resolved.push({
      kind: 'OCCURRENCE',
      catalogItemId: null,
      occurrenceId,
      // Deliberately no client-supplied quantity: seat count is
      // participants.length, matching the Cart contract's CartLine shape.
      quantity: line.participants.length,
      unitPriceCents: row.priceCents,
      nameSnapshot: row.name,
      currency: row.currency,
      participants: line.participants,
    });
  }

  // Dropping an unavailable line and charging for the rest would sell the
  // customer something other than what they reviewed, so a currency
  // disagreement rejects the whole cart rather than silently picking one.
  const currencies = [...new Set(resolved.map((line) => line.currency))];
  if (currencies.length > 1) {
    throw new MixedCurrencyError(currencies);
  }

  return resolved;
}

// cartSchema.parse returns CartInput — plain unbranded strings for every id,
// since @keki/contracts has no Drizzle/branding dependency at the zod-schema
// level. Everything downstream (SeatHolder, ResolvedLine) is typed against
// the branded Cart/CartParticipantRef, so the parsed input is normalized
// into branded form once, here, rather than scattering id-brand conversions
// through resolveCartLines and the seat-holding loop.
type ParsedCartLine = CartInput['lines'][number];
type ParsedParticipant = Extract<ParsedCartLine, { kind: 'OCCURRENCE' }>['participants'][number];

function toBrandedParticipant(participant: ParsedParticipant): CartParticipantRef {
  return participant.kind === 'CUSTOMER'
    ? { kind: 'CUSTOMER', customerId: createCustomerId(participant.customerId) }
    : { kind: 'CHILD', childId: createChildId(participant.childId) };
}

function toBrandedCart(parsed: CartInput): Cart {
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

export async function createOrder(input: {
  cart: Cart;
  householdId: HouseholdId;
  createdByCustomerId: CustomerId;
  seatHolder: SeatHolder;
  holdTtlMinutes?: number;
  now?: Date;
}): Promise<{ order: Order; lineItems: readonly OrderLineItem[] }> {
  const now = input.now ?? new Date();
  const holdTtlMinutes = input.holdTtlMinutes ?? DEFAULT_HOLD_TTL_MINUTES;

  // Parsed here even though a caller may claim the cart is already
  // validated: this function persists money and is reachable from more than
  // one caller. This is also what makes a client-supplied price
  // unrepresentable (SC-04) — cartSchema has no price field to tamper with.
  const cart: Cart = toBrandedCart(cartSchema.parse(input.cart));

  // Everything below shares this single `tx`. That is what makes SC-19 true:
  // a capacity rejection at the seat-holding step rolls back the order row
  // inserted before it, and a line-item insert failure releases the holds
  // taken before it — because both live in the same Postgres transaction,
  // not two connections that can drift out of sync.
  return withTransaction(async (tx) => {
    const allParticipants = cart.lines.flatMap((line) =>
      line.kind === 'OCCURRENCE' ? line.participants : [],
    );
    if (allParticipants.length > 0) {
      await assertParticipantsInHousehold({
        householdId: input.householdId,
        participants: allParticipants,
        tx,
      });
    }

    const resolvedLines = await resolveCartLines(cart, tx, now);

    // Our arithmetic for display and reconciliation only — Square computes
    // the actual charge amount, including tax, when startCheckout calls
    // createCheckout. Never treat subtotalCents as what the customer pays.
    const subtotalCents = resolvedLines.reduce(
      (sum, line) => sum + line.unitPriceCents * line.quantity,
      0,
    );
    const currency = resolvedLines[0]?.currency ?? 'USD';
    const expiresAt = new Date(now.getTime() + holdTtlMinutes * 60_000);

    const [orderRow] = await tx
      .insert(orders)
      .values({
        householdId: input.householdId,
        createdByCustomerId: input.createdByCustomerId,
        status: 'DRAFT',
        subtotalCents,
        currency,
        expiresAt,
      })
      .returning();
    if (orderRow === undefined) {
      throw new Error('createOrder: insert into orders returned no row.');
    }

    const lineItemValues: Array<{
      orderId: string;
      kind: OrderLineItemKind;
      catalogItemId: CatalogItemId | null;
      occurrenceId: OccurrenceId | null;
      reservationId: ReservationId | null;
      quantity: number;
      unitPriceCents: number;
      nameSnapshot: string;
    }> = [];

    for (const line of resolvedLines) {
      let reservationId: ReservationId | null = null;
      if (line.kind === 'OCCURRENCE' && line.occurrenceId !== null) {
        // Let CapacityExceededError from the seat holder propagate
        // unchanged: wrapping it here would lose the occurrence id the UI
        // needs to tell the customer which class sold out. The seat holder
        // receives this same `tx`, never a fresh connection.
        const held = await input.seatHolder.holdSeats({
          occurrenceId: line.occurrenceId,
          householdId: input.householdId,
          createdByCustomerId: input.createdByCustomerId,
          participants: line.participants,
          holdTtlMinutes,
          tx,
        });
        reservationId = held.reservationId;
      }
      lineItemValues.push({
        orderId: orderRow.id,
        kind: line.kind,
        catalogItemId: line.catalogItemId,
        occurrenceId: line.occurrenceId,
        reservationId,
        quantity: line.quantity,
        unitPriceCents: line.unitPriceCents,
        nameSnapshot: line.nameSnapshot,
      });
    }

    const insertedLineItemRows = await tx.insert(orderLineItems).values(lineItemValues).returning();

    return {
      order: toOrder(orderRow),
      lineItems: insertedLineItemRows.map(toOrderLineItem),
    };
  });
}
