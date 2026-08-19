import { notFound } from 'next/navigation';
import { getOrderWithLineItems } from '@keki/commerce-core';
import { createOrderId } from '@keki/contracts';
import { PageShell, Price } from '@keki/ui';
import { requireRole } from '../../../../auth/guards';
import { PaymentForm } from './payment-form';

// Order state must be read fresh — a cached page would show a stale total or
// let an already-paid order be paid again.
export const dynamic = 'force-dynamic';

export default async function MockCheckoutPage({ params }: { params: Promise<{ orderId: string }> }) {
  const session = await requireRole('CUSTOMER');
  const { orderId: rawOrderId } = await params;

  // Refuse outright rather than rendering a disabled page: the route should
  // simply not exist unless the demo flag is on, and never in production.
  if (process.env['NODE_ENV'] === 'production' || process.env['KEKI_ENABLE_MOCK_CHECKOUT'] !== 'true') {
    notFound();
  }

  let orderId;
  try {
    orderId = createOrderId(rawOrderId);
  } catch {
    notFound();
  }

  const found = await getOrderWithLineItems(orderId);
  // Household check, not just existence: an order id is a uuid, but that is
  // not a permission to view or pay it.
  if (found === null || found.order.householdId !== session.profile.householdId) {
    notFound();
  }

  const { order, lineItems } = found;
  const totalLabel = `$${(order.subtotalCents / 100).toFixed(2)}`;

  return (
    <PageShell title="Checkout" description="Review your order and complete payment.">
      <div className="mx-auto flex w-full max-w-md flex-col gap-6">
        <p className="rounded-lg border border-brand-300 bg-brand-50 px-4 py-3 text-sm text-brand-900">
          <strong>Demo checkout.</strong> This is a stand-in for Square&apos;s hosted payment page so
          the flow can be shown end to end locally. No card details are read or sent anywhere, and no
          money moves.
        </p>

        <section className="flex flex-col gap-3 rounded-xl border border-surface-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-surface-900">Order summary</h2>
          <ul className="flex flex-col gap-2">
            {lineItems.map((line) => (
              <li key={line.id} className="flex items-baseline justify-between gap-4 text-sm">
                <span className="text-surface-700">
                  {line.nameSnapshot}
                  {line.quantity > 1 && <span className="text-surface-500"> × {line.quantity}</span>}
                </span>
                <Price cents={line.unitPriceCents * line.quantity} currency={order.currency} />
              </li>
            ))}
          </ul>
          <div className="flex items-baseline justify-between border-t border-surface-200 pt-3">
            <span className="text-sm font-semibold text-surface-900">Subtotal</span>
            <Price cents={order.subtotalCents} currency={order.currency} />
          </div>
          <p className="text-xs text-surface-500">
            Tax is calculated by Square at checkout on a real order.
          </p>
        </section>

        <section className="flex flex-col gap-4 rounded-xl border border-surface-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-surface-900">Payment details</h2>
          <PaymentForm orderId={rawOrderId} totalLabel={totalLabel} />
        </section>
      </div>
    </PageShell>
  );
}
