import { listBookableOfferings, listCafeItems } from '@keki/catalog-core';
import { listHouseholdMembers } from '@keki/customer-core';
import {
  cartParticipantRefKey,
  type CatalogItemId,
  type HouseholdId,
  type OccurrenceId,
} from '@keki/contracts';
import { readCart } from './cart-cookie';

const DEFAULT_CURRENCY = 'USD';

export interface ResolvedCartLine {
  readonly id: string;
  readonly kind: 'CATALOG_ITEM' | 'OCCURRENCE';
  readonly catalogItemId?: CatalogItemId;
  readonly occurrenceId?: OccurrenceId;
  readonly name: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
  readonly currency: string;
  readonly lineTotalCents: number;
  readonly participantNames?: readonly string[];
  readonly available: boolean;
  readonly unavailableReason?: string;
}

export interface ResolvedCart {
  readonly lines: readonly ResolvedCartLine[];
  readonly subtotalCents: number;
  readonly currency: string;
}

function displayNameForMember(member: { firstName: string; lastName: string }): string {
  return `${member.firstName} ${member.lastName}`;
}

/**
 * Reads the cart cookie and resolves every line against the current
 * catalog. Every price and every participant name is looked up here, not
 * trusted from the cookie — the same rule WS-05's createOrder applies at
 * order creation, applied to display. `listCafeItems`/`listBookableOfferings`
 * only ever return ACTIVE/PUBLISHED-and-open rows, so a line whose id
 * doesn't appear in either map is exactly an archived item, a cancelled or
 * past occurrence, or an occurrence whose offering was unpublished — all of
 * which render "unavailable" rather than being silently dropped.
 */
export async function resolveCart(householdId: HouseholdId | null): Promise<ResolvedCart> {
  const cart = await readCart();
  if (cart.lines.length === 0) {
    return { lines: [], subtotalCents: 0, currency: DEFAULT_CURRENCY };
  }

  const [cafeItems, occurrences, householdMembers] = await Promise.all([
    listCafeItems(),
    listBookableOfferings(),
    householdId === null ? Promise.resolve({ customers: [], children: [] }) : listHouseholdMembers(householdId),
  ]);

  const cafeItemsById = new Map(cafeItems.map((item) => [item.catalogItemId, item]));
  const occurrencesById = new Map(occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]));
  const namesByParticipantKey = new Map([
    ...householdMembers.customers.map(
      (customer) =>
        [cartParticipantRefKey({ kind: 'CUSTOMER', customerId: customer.id }), displayNameForMember(customer)] as const,
    ),
    ...householdMembers.children.map(
      (child) => [cartParticipantRefKey({ kind: 'CHILD', childId: child.id }), displayNameForMember(child)] as const,
    ),
  ]);

  const lines: ResolvedCartLine[] = cart.lines.map((line) => {
    if (line.kind === 'CATALOG_ITEM') {
      const item = cafeItemsById.get(line.catalogItemId);
      if (item === undefined) {
        return {
          id: `CATALOG_ITEM:${line.catalogItemId}`,
          kind: 'CATALOG_ITEM',
          catalogItemId: line.catalogItemId,
          name: 'Item no longer available',
          quantity: line.quantity,
          unitPriceCents: 0,
          currency: DEFAULT_CURRENCY,
          lineTotalCents: 0,
          available: false,
          unavailableReason: 'This item is no longer available.',
        };
      }
      return {
        id: `CATALOG_ITEM:${line.catalogItemId}`,
        kind: 'CATALOG_ITEM',
        catalogItemId: line.catalogItemId,
        name: item.name,
        quantity: line.quantity,
        unitPriceCents: item.priceCents,
        currency: item.currency,
        lineTotalCents: item.priceCents * line.quantity,
        available: true,
      };
    }

    const participantNames = line.participants.map(
      (participant) => namesByParticipantKey.get(cartParticipantRefKey(participant)) ?? 'Unknown participant',
    );
    const occurrence = occurrencesById.get(line.occurrenceId);
    if (occurrence === undefined) {
      return {
        id: `OCCURRENCE:${line.occurrenceId}`,
        kind: 'OCCURRENCE',
        occurrenceId: line.occurrenceId,
        name: 'Class no longer available',
        quantity: line.participants.length,
        unitPriceCents: 0,
        currency: DEFAULT_CURRENCY,
        lineTotalCents: 0,
        participantNames,
        available: false,
        unavailableReason: 'This class is no longer open for booking.',
      };
    }

    const soldOut = line.participants.length > occurrence.seatsRemaining;
    return {
      id: `OCCURRENCE:${line.occurrenceId}`,
      kind: 'OCCURRENCE',
      occurrenceId: line.occurrenceId,
      name: occurrence.name,
      quantity: line.participants.length,
      unitPriceCents: occurrence.priceCents,
      currency: occurrence.currency,
      lineTotalCents: occurrence.priceCents * line.participants.length,
      participantNames,
      available: !soldOut,
      ...(soldOut ? { unavailableReason: 'This class has sold out.' } : {}),
    };
  });

  const availableLines = lines.filter((line) => line.available);
  const subtotalCents = availableLines.reduce((sum, line) => sum + line.lineTotalCents, 0);
  const currency = availableLines[0]?.currency ?? lines[0]?.currency ?? DEFAULT_CURRENCY;

  return { lines, subtotalCents, currency };
}
