import { listOfferings } from '@keki/catalog-admin';
import type { Offering, OfferingStatus } from '@keki/contracts';
import { EmptyState, PageShell, Price, StatusBadge, type StatusBadgeTone } from '@keki/ui';
import { OfferingForm } from './offering-form';
import { OfferingRow } from './offering-row';

// A manager who creates or transitions an offering expects the list below
// to reflect it immediately, not on the next route-cache revalidation.
export const dynamic = 'force-dynamic';

// Drafts first (the unfinished work a manager came to finish), then
// published, then archived (history, and belongs last).
const STATUS_ORDER: readonly OfferingStatus[] = ['DRAFT', 'PUBLISHED', 'ARCHIVED'];

const STATUS_BADGE: Readonly<Record<OfferingStatus, { readonly label: string; readonly tone: StatusBadgeTone }>> = {
  DRAFT: { label: 'Draft', tone: 'neutral' },
  PUBLISHED: { label: 'Published', tone: 'accent' },
  ARCHIVED: { label: 'Archived', tone: 'muted' },
};

function groupByStatus(offerings: readonly Offering[]): readonly Offering[] {
  return STATUS_ORDER.flatMap((status) => offerings.filter((offering) => offering.status === status));
}

export default async function AdminOfferingsPage() {
  const offerings = await listOfferings();
  const sorted = groupByStatus(offerings);

  return (
    <PageShell
      title="Offerings"
      description="Define classes and control what's for sale. Only CLASS offerings are supported this program. Publishing makes a class visible to customers on the booking page — it is the moment a class becomes purchasable."
    >
      <div className="flex flex-col gap-8">
        <section className="flex flex-col gap-3 rounded-lg border border-surface-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-surface-900">Create offering</h2>
          <OfferingForm />
        </section>

        {sorted.length === 0 ? (
          <EmptyState
            title="No offerings yet"
            description="Create your first class above to get started."
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {sorted.map((offering) => {
              const badge = STATUS_BADGE[offering.status];
              return (
                <li
                  key={offering.id}
                  className="flex flex-col gap-3 rounded-lg border border-surface-200 bg-white p-4"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-semibold text-surface-900">{offering.name}</h3>
                        <StatusBadge label={badge.label} tone={badge.tone} />
                      </div>
                      <p className="text-xs text-surface-600">
                        {offering.durationMinutes} min · Capacity {offering.defaultCapacity}
                      </p>
                    </div>
                    <Price cents={offering.priceCents} currency={offering.currency} />
                  </div>
                  <OfferingRow offering={offering} />
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </PageShell>
  );
}
