import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getOrderWithLineItems } from '@keki/commerce-core';
import { listHouseholdMembers } from '@keki/customer-core';
import { listParticipantsForReservation } from '@keki/reservation-core';
import {
  cartParticipantRefKey,
  createOrderId,
  type Order,
  type OrderId,
  type OrderLineItem,
} from '@keki/contracts';
import { OrderSummary, PageShell, type OrderSummaryLine } from '@keki/ui';
import { getSessionResult } from '../../../auth/require-session';

// Every order lookup is per-customer and must reflect the current payment
// state on every visit — the same reasoning as the cart and book pages.
export const dynamic = 'force-dynamic';

interface OrderStatusPageProps {
  readonly params: Promise<{ orderId: string }>;
}

function displayNameForMember(member: { firstName: string; lastName: string }): string {
  return `${member.firstName} ${member.lastName}`;
}

async function toSummaryLine(
  lineItem: OrderLineItem,
  order: Order,
  namesByParticipantKey: ReadonlyMap<string, string>,
): Promise<OrderSummaryLine> {
  let participantNames: readonly string[] | undefined;
  if (lineItem.kind === 'OCCURRENCE' && lineItem.reservationId !== null) {
    const participants = await listParticipantsForReservation(lineItem.reservationId);
    participantNames = participants.map(
      (participant) => namesByParticipantKey.get(cartParticipantRefKey(participant)) ?? 'Unknown participant',
    );
  }

  return {
    id: lineItem.id,
    name: lineItem.nameSnapshot,
    quantity: lineItem.quantity,
    unitPriceCents: lineItem.unitPriceCents,
    currency: order.currency,
    lineTotalCents: lineItem.unitPriceCents * lineItem.quantity,
    ...(participantNames !== undefined ? { participantNames } : {}),
  };
}

export default async function OrderStatusPage({ params }: OrderStatusPageProps) {
  const { orderId: rawOrderId } = await params;

  const sessionResult = await getSessionResult();
  if (sessionResult.kind !== 'authenticated') {
    notFound();
  }
  const { session } = sessionResult;

  // createOrderId throws for anything that isn't a UUID v4 — treated the
  // same as "not found" rather than a distinct error, so a malformed id in
  // the URL reveals nothing about which ids are well-formed.
  let orderId: OrderId;
  try {
    orderId = createOrderId(rawOrderId);
  } catch {
    notFound();
  }

  const found = await getOrderWithLineItems(orderId);
  if (found === null) {
    notFound();
  }
  const { order, lineItems } = found;

  // Object-level authorization: order ids are uuids, but that is not a
  // substitute for checking the order actually belongs to this household.
  if (order.householdId !== session.profile.householdId) {
    notFound();
  }

  const householdMembers = await listHouseholdMembers(order.householdId);
  const namesByParticipantKey = new Map([
    ...householdMembers.customers.map(
      (customer) =>
        [cartParticipantRefKey({ kind: 'CUSTOMER', customerId: customer.id }), displayNameForMember(customer)] as const,
    ),
    ...householdMembers.children.map(
      (child) => [cartParticipantRefKey({ kind: 'CHILD', childId: child.id }), displayNameForMember(child)] as const,
    ),
  ]);

  const lines = await Promise.all(
    lineItems.map((lineItem) => toSummaryLine(lineItem, order, namesByParticipantKey)),
  );

  return (
    <PageShell title="Order status">
      <div className="flex flex-col gap-6">
        {/* This page never transitions the order — a customer returning
            from Square is not proof of payment, since the redirect fires
            whether or not the charge succeeded. Only WS-10's signed webhook
            may set PAID. */}
        {order.status === 'PAID' && (
          <p role="status" className="rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-800">
            Payment confirmed. Thank you!
          </p>
        )}
        {order.status === 'AWAITING_PAYMENT' && (
          <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800">
            Payment is processing. This is normal — it usually finishes within a few seconds. Refresh this
            page if it has been a few minutes.
          </p>
        )}
        {order.status === 'DRAFT' && (
          <p className="rounded-lg border border-surface-300 bg-surface-50 p-4 text-sm text-surface-700">
            Checkout was not completed.{' '}
            <Link href="/cart" className="font-medium underline">
              Return to your cart
            </Link>{' '}
            to try again.
          </p>
        )}
        {(order.status === 'CANCELLED' || order.status === 'EXPIRED') && (
          <p className="rounded-lg border border-surface-300 bg-surface-50 p-4 text-sm text-surface-700">
            This order was {order.status === 'CANCELLED' ? 'cancelled' : 'never completed and expired'}.{' '}
            <Link href="/book" className="font-medium underline">
              Book something new
            </Link>
            .
          </p>
        )}
        <OrderSummary status={order.status} lines={lines} subtotalCents={order.subtotalCents} currency={order.currency} />
      </div>
    </PageShell>
  );
}
