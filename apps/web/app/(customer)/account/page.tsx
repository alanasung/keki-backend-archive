import Link from 'next/link';
import { listOrdersForHousehold } from '@keki/commerce-core';
import { listHouseholdMembers } from '@keki/customer-core';
import type { Order, OrderStatus } from '@keki/contracts';
import { PageShell, Price } from '@keki/ui';
import { requireRole } from '../../auth/guards';

// Household membership and order state both change outside this page's
// control — a cached copy would show a stale order status right after
// checkout, which is exactly when a customer looks.
export const dynamic = 'force-dynamic';

// Read-only by design. Editing a household, adding a child, buying or
// spending a play pass, and signing a waiver all rest on domain commands
// that still reject with NotImplementedInPhase1 (customer-core's addChild
// and updateHousehold, every command in pass-core, startWaiverSigning), so
// those sections state that plainly rather than rendering controls that
// cannot work.

const STATUS_LABEL: Record<OrderStatus, string> = {
  DRAFT: 'Not completed',
  AWAITING_PAYMENT: 'Payment processing',
  PAID: 'Confirmed',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
};

const STATUS_TONE: Record<OrderStatus, string> = {
  DRAFT: 'bg-surface-100 text-surface-700',
  AWAITING_PAYMENT: 'bg-brand-100 text-brand-900',
  PAID: 'bg-brand-500 text-white',
  CANCELLED: 'bg-surface-200 text-surface-700',
  EXPIRED: 'bg-surface-200 text-surface-700',
};

// The cafe's local timezone, not the server's: `occurrences` are timestamptz
// precisely because this business crosses DST, and formatting in UTC would
// show the wrong day to a customer twice a year.
const DISPLAY_TIME_ZONE = 'America/Los_Angeles';

function formatDate(value: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: DISPLAY_TIME_ZONE,
  }).format(value);
}

function formatDateOnly(value: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeZone: DISPLAY_TIME_ZONE,
  }).format(value);
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-surface-600">{title}</h2>
      {children}
    </section>
  );
}

function ComingSoon({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-surface-300 bg-surface-100 px-4 py-6 text-sm text-surface-600">
      {children}
    </p>
  );
}

function OrderRow({ order }: { order: Order }) {
  return (
    <li>
      <Link
        href={{ pathname: `/orders/${order.id}` }}
        className="flex items-center justify-between gap-4 rounded-xl border border-surface-200 bg-white p-4 transition hover:border-brand-500"
      >
        <span className="flex flex-col gap-1">
          <span className="text-sm font-semibold text-surface-900">{formatDate(order.createdAt)}</span>
          <span className={`w-fit rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_TONE[order.status]}`}>
            {STATUS_LABEL[order.status]}
          </span>
        </span>
        <span className="text-sm font-semibold text-surface-900">
          <Price cents={order.subtotalCents} currency={order.currency} />
        </span>
      </Link>
    </li>
  );
}

export default async function AccountPage() {
  const session = await requireRole('CUSTOMER');
  const householdId = session.profile.householdId;

  // An authenticated profile without a household is a provisioning bug, not
  // a customer-facing state — say so rather than rendering empty sections
  // that look like "you have nothing yet".
  if (householdId === null) {
    return (
      <PageShell title="Account" description="Your household, orders, passes, and waivers.">
        <p className="text-sm text-surface-600">
          This profile is not linked to a household yet. Please contact the cafe.
        </p>
      </PageShell>
    );
  }

  // Deliberately not calling getHouseholdById: it throws when
  // `primary_customer_id` is null, and that column is nullable — the
  // `Household` contract type declares it non-null, so any household without
  // one (every seeded household, for instance) takes the whole page down.
  // Nothing here needs the household row itself.
  const [members, orders] = await Promise.all([
    listHouseholdMembers(householdId),
    listOrdersForHousehold(householdId),
  ]);

  // Newest first: an account page is read to check something recent.
  const sortedOrders = [...orders].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  return (
    <PageShell
      title="Account"
      description="Your household, orders, passes, and waivers."
    >
      <div className="flex max-w-2xl flex-col gap-8">
        <Section title="Household">
          <ul className="flex flex-col gap-2">
            {members.customers.map((customer) => (
              <li
                key={customer.id}
                className="flex items-center justify-between gap-4 rounded-xl border border-surface-200 bg-white px-4 py-3"
              >
                <span className="flex flex-col">
                  <span className="text-sm text-surface-900">
                    {customer.firstName} {customer.lastName}
                  </span>
                  <span className="text-xs text-surface-500">{customer.email}</span>
                </span>
                <span className="text-xs font-semibold uppercase tracking-wide text-surface-500">
                  Adult
                </span>
              </li>
            ))}
            {members.children.map((child) => (
              <li
                key={child.id}
                className="flex items-center justify-between gap-4 rounded-xl border border-surface-200 bg-white px-4 py-3"
              >
                <span className="flex flex-col">
                  <span className="text-sm text-surface-900">
                    {child.firstName} {child.lastName}
                  </span>
                  <span className="text-xs text-surface-500">
                    Born {formatDateOnly(child.dateOfBirth)}
                  </span>
                </span>
                <span className="text-xs font-semibold uppercase tracking-wide text-surface-500">
                  Child
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-surface-500">
            Adding or editing household members is not available yet.
          </p>
        </Section>

        <Section title="Orders">
          {sortedOrders.length === 0 ? (
            <p className="text-sm text-surface-600">
              No orders yet.{' '}
              <Link href={{ pathname: '/book' }} className="text-brand-700 underline">
                Browse the menu
              </Link>
              .
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {sortedOrders.map((order) => (
                <OrderRow key={order.id} order={order} />
              ))}
            </ul>
          )}
        </Section>

        <Section title="Play passes">
          <ComingSoon>
            Play passes are not available yet. Buying and spending credits arrives with the passes
            work.
          </ComingSoon>
        </Section>

        <Section title="Waivers">
          <ComingSoon>
            Waiver signing is not available yet. It arrives with the waiver provider integration.
          </ComingSoon>
        </Section>
      </div>
    </PageShell>
  );
}
