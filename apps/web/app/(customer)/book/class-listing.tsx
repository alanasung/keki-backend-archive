import { listBookableOfferings } from '@keki/catalog-core';
import { listHouseholdMembers } from '@keki/customer-core';
import type { BookableOccurrenceView, Child, Customer, HouseholdMemberView } from '@keki/contracts';
import { CatalogItemCard, EmptyState } from '@keki/ui';
import { getSessionResult } from '../../auth/require-session';
import { ParticipantPicker } from './participant-picker';

// `occurrences.starts_at` is stored as `timestamptz` specifically so a
// class scheduled across a DST boundary still shows the right local hour
// (see packages/database/src/schema/catalog.ts). Rendering in the
// server's zone or in UTC would show customers the wrong time twice a
// year, so every formatter below is pinned to this single named constant.
// Exported so /admin/schedules (WS-07) renders the same class at the same
// local hour instead of declaring a second constant that could drift.
export const CAFE_TIME_ZONE = 'America/Los_Angeles';

// Below this many seats, surface a hint so a customer doesn't lose a race
// they could have won by clicking sooner. This number is stale the moment
// it's read — WS-02's capacity trigger is the real check, and WS-09 must
// still handle a CONFLICT from a sold-out race.
const LOW_SEAT_THRESHOLD = 3;

const dayKeyFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: CAFE_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const dayHeadingFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: CAFE_TIME_ZONE,
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
});

const startTimeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: CAFE_TIME_ZONE,
  hour: 'numeric',
  minute: '2-digit',
});

type DayGroup = readonly [dayKey: string, occurrences: readonly BookableOccurrenceView[]];

function groupByDay(occurrences: readonly BookableOccurrenceView[]): readonly DayGroup[] {
  const groups = new Map<string, BookableOccurrenceView[]>();

  for (const occurrence of occurrences) {
    const dayKey = dayKeyFormatter.format(occurrence.startsAt);
    const existing = groups.get(dayKey);
    if (existing === undefined) {
      groups.set(dayKey, [occurrence]);
    } else {
      existing.push(occurrence);
    }
  }

  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([dayKey, dayOccurrences]) =>
        [dayKey, [...dayOccurrences].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())] as const,
    );
}

function seatAvailabilityLabel(seatsRemaining: number): string {
  if (seatsRemaining <= 0) {
    return 'Sold out';
  }
  if (seatsRemaining <= LOW_SEAT_THRESHOLD) {
    return `Only ${seatsRemaining} seat${seatsRemaining === 1 ? '' : 's'} left`;
  }
  return `${seatsRemaining} seats left`;
}

// `listHouseholdMembers` already returns every customer and child in the
// household — including the signed-in customer themself. When the household
// has no children, that customer is the household's only member, so this
// naturally yields a one-option list rather than an empty one; no
// account-holder special case is needed here.
function toMemberViews(members: { customers: readonly Customer[]; children: readonly Child[] }): HouseholdMemberView[] {
  return [
    ...members.customers.map((customer) => ({
      ref: { kind: 'CUSTOMER' as const, customerId: customer.id },
      displayName: `${customer.firstName} ${customer.lastName}`,
      dateOfBirth: null,
    })),
    ...members.children.map((child) => ({
      ref: { kind: 'CHILD' as const, childId: child.id },
      displayName: `${child.firstName} ${child.lastName}`,
      dateOfBirth: child.dateOfBirth,
    })),
  ];
}

// Server Component: fetches its own data, groups by local calendar day. No
// mutation of its own — `ParticipantPicker` in the footer is the client
// island that owns the seat-booking mutation; this component's only job is
// loading the household member list that picker renders.
export async function ClassListing() {
  const [occurrences, sessionResult] = await Promise.all([listBookableOfferings(), getSessionResult()]);

  if (occurrences.length === 0) {
    return (
      <section aria-label="Classes" className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold text-surface-900">Classes</h2>
        <EmptyState title="No classes scheduled" description="New classes haven't been published yet." />
      </section>
    );
  }

  // The customer layout already enforces CUSTOMER role before this page
  // renders (see (customer)/layout.tsx's requireRole call, cached via
  // React's cache() so this doesn't re-verify the token). `householdId` is
  // nullable on the profile type regardless, so this still degrades to no
  // pickable members instead of throwing if that invariant is ever broken.
  const householdId = sessionResult.kind === 'authenticated' ? sessionResult.session.profile.householdId : null;
  const members = householdId === null ? [] : toMemberViews(await listHouseholdMembers(householdId));

  const groups = groupByDay(occurrences);

  return (
    <section aria-label="Classes" className="flex flex-col gap-6">
      <h2 className="text-lg font-semibold text-surface-900">Classes</h2>
      {groups.map(([dayKey, dayOccurrences]) => (
        <div key={dayKey} className="flex flex-col gap-4">
          <h3 className="text-sm font-semibold text-surface-700">
            {dayHeadingFormatter.format(dayOccurrences[0]!.startsAt)}
          </h3>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {dayOccurrences.map((occurrence) => (
              <div key={occurrence.occurrenceId} className="flex flex-col gap-2">
                <p className="text-xs font-medium text-surface-500">
                  <time dateTime={occurrence.startsAt.toISOString()}>
                    {startTimeFormatter.format(occurrence.startsAt)}
                  </time>
                </p>
                <CatalogItemCard
                  name={occurrence.name}
                  description={occurrence.description}
                  priceCents={occurrence.priceCents}
                  currency={occurrence.currency}
                  footer={
                    <div className="flex flex-col gap-2">
                      <span className="text-xs text-surface-600">{seatAvailabilityLabel(occurrence.seatsRemaining)}</span>
                      {occurrence.seatsRemaining > 0 && (
                        <ParticipantPicker
                          occurrenceId={occurrence.occurrenceId}
                          members={members}
                          seatsRemaining={occurrence.seatsRemaining}
                        />
                      )}
                    </div>
                  }
                />
              </div>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
