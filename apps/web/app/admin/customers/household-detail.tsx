import { CAFE_TIME_ZONE, type Child, type Customer, type Order, type OrderStatus } from '@keki/contracts';
import { EmptyState, Price, StatusBadge, type StatusBadgeTone } from '@keki/ui';

export interface HouseholdDetailProps {
  readonly householdName: string;
  readonly members: { readonly customers: readonly Customer[]; readonly children: readonly Child[] };
  readonly orders: readonly Order[];
}

const ORDER_STATUS_BADGE: Readonly<Record<OrderStatus, { readonly label: string; readonly tone: StatusBadgeTone }>> = {
  DRAFT: { label: 'Not completed', tone: 'neutral' },
  AWAITING_PAYMENT: { label: 'Payment processing', tone: 'neutral' },
  PAID: { label: 'Confirmed', tone: 'accent' },
  CANCELLED: { label: 'Cancelled', tone: 'muted' },
  EXPIRED: { label: 'Expired', tone: 'muted' },
};

// `children.date_of_birth` is a plain calendar date (see
// packages/database/src/schema/people.ts), read back as a UTC-midnight
// `Date`. Formatting it in the cafe's local time zone would show the day
// before for any zone west of UTC — this formats in UTC instead, since a
// calendar date has no time-of-day component to convert.
const dateOfBirthFormatter = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });

const orderDateFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: CAFE_TIME_ZONE,
});

function Section({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-surface-600">{title}</h3>
      {children}
    </section>
  );
}

export function HouseholdDetail({ householdName, members, orders }: HouseholdDetailProps) {
  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-lg font-semibold text-surface-900">{householdName}</h2>

      <Section title="Members">
        <ul className="flex flex-col gap-2">
          {members.customers.map((customer) => (
            <li
              key={customer.id}
              className="flex flex-col rounded-lg border border-surface-200 bg-white px-4 py-3"
            >
              <span className="text-sm text-surface-900">
                {customer.firstName} {customer.lastName}
              </span>
              <span className="text-xs text-surface-500">{customer.email}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Children">
        {members.children.length === 0 ? (
          <EmptyState title="No children" description="This household has no children on file." />
        ) : (
          <ul className="flex flex-col gap-2">
            {members.children.map((child) => (
              <li
                key={child.id}
                className="flex flex-col rounded-lg border border-surface-200 bg-white px-4 py-3"
              >
                <span className="text-sm text-surface-900">
                  {child.firstName} {child.lastName}
                </span>
                <span className="text-xs text-surface-500">
                  Born {dateOfBirthFormatter.format(child.dateOfBirth)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Recent orders">
        {orders.length === 0 ? (
          <EmptyState title="No orders" description="This household has not placed an order." />
        ) : (
          <ul className="flex flex-col gap-2">
            {orders.map((order) => {
              const badge = ORDER_STATUS_BADGE[order.status];
              return (
                <li
                  key={order.id}
                  className="flex items-center justify-between gap-4 rounded-lg border border-surface-200 bg-white px-4 py-3"
                >
                  <span className="flex flex-col gap-1">
                    <span className="text-sm text-surface-900">{orderDateFormatter.format(order.createdAt)}</span>
                    <StatusBadge label={badge.label} tone={badge.tone} />
                  </span>
                  <span className="text-sm font-semibold text-surface-900">
                    <Price cents={order.subtotalCents} currency={order.currency} />
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </div>
  );
}
