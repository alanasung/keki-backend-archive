import Link from 'next/link';
import { notFound } from 'next/navigation';
import { listOrdersForHousehold } from '@keki/commerce-core';
import { getHouseholdName, listHouseholdMembers, searchCustomers } from '@keki/customer-core';
import { createHouseholdId, type Child, type Customer, type HouseholdId, type Order } from '@keki/contracts';
import { EmptyState, PageShell } from '@keki/ui';
import { CustomerSearch } from './customer-search';
import { HouseholdDetail } from './household-detail';

// Household membership and order state both change outside this page's
// control, and it's pulled up mid-call with a customer — a cached copy could
// show a stale order or a household member who no longer belongs.
export const dynamic = 'force-dynamic';

// Mirrors searchCustomers' own minimum: below this, the query is never
// actually run (see below), so a one- or zero-character term reads as "no
// matches" rather than throwing SearchQueryTooShortError up through the page.
const SEARCH_QUERY_MIN_LENGTH = 2;

interface AdminCustomersPageProps {
  readonly searchParams: Promise<{ readonly q?: string; readonly householdId?: string }>;
}

interface HouseholdMembers {
  readonly customers: readonly Customer[];
  readonly children: readonly Child[];
}

export default async function AdminCustomersPage({ searchParams }: AdminCustomersPageProps) {
  const params = await searchParams;

  // A search result and a selected household both come from the URL, not
  // component state, so a staff member can send either to a colleague — the
  // same reasoning as /admin/reservations' occurrenceId selection.
  let householdId: HouseholdId | undefined;
  if (params.householdId !== undefined) {
    try {
      householdId = createHouseholdId(params.householdId);
    } catch {
      notFound();
    }
  }

  let householdName: string | null = null;
  let members: HouseholdMembers | null = null;
  let orders: readonly Order[] = [];
  if (householdId !== undefined) {
    householdName = await getHouseholdName(householdId);
    if (householdName === null) {
      notFound();
    }
    [members, orders] = await Promise.all([listHouseholdMembers(householdId), listOrdersForHousehold(householdId)]);
  }

  const trimmedQuery = params.q?.trim() ?? '';
  const hasSearched = trimmedQuery.length > 0;
  const results =
    hasSearched && trimmedQuery.length >= SEARCH_QUERY_MIN_LENGTH ? await searchCustomers({ query: trimmedQuery }) : [];

  return (
    <PageShell
      title="Customers"
      description="Look up a household by customer email or name, then see who is in it, which children belong to it, and what they have ordered."
    >
      <div className="flex flex-col gap-6">
        <CustomerSearch {...(params.q !== undefined ? { defaultValue: params.q } : {})} />

        {!hasSearched ? (
          <EmptyState title="Search for a customer" description="Enter an email or name above to find a household." />
        ) : results.length === 0 ? (
          <EmptyState title="No matches" description={`No customers matched "${trimmedQuery}".`} />
        ) : (
          <ul className="flex flex-col gap-2">
            {results.map((result) => (
              <li key={result.customerId}>
                <Link
                  href={{
                    pathname: '/admin/customers',
                    query: { q: params.q, householdId: result.householdId },
                  }}
                  className="flex flex-col rounded-lg border border-surface-200 bg-white px-4 py-3 transition hover:border-brand-500"
                >
                  <span className="text-sm text-surface-900">
                    {result.firstName} {result.lastName}
                  </span>
                  <span className="text-xs text-surface-500">{result.email}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        {householdName !== null && members !== null && (
          <HouseholdDetail householdName={householdName} members={members} orders={orders} />
        )}
      </div>
    </PageShell>
  );
}
