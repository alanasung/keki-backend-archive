import { listOfferings, listUpcomingOccurrences, type AdminOccurrenceView } from '@keki/catalog-admin';
import type { OccurrenceStatus, OfferingStatus } from '@keki/contracts';
import { EmptyState, PageShell, StatusBadge, type StatusBadgeTone } from '@keki/ui';
import { CAFE_TIME_ZONE } from '../../(customer)/book/class-listing';
import { OccurrenceRow } from './occurrence-row';
import { ScheduleForm } from './schedule-form';

const OCCURRENCE_STATUS_BADGE: Readonly<Record<OccurrenceStatus, { readonly label: string; readonly tone: StatusBadgeTone }>> = {
  SCHEDULED: { label: 'Scheduled', tone: 'accent' },
  CANCELLED: { label: 'Cancelled', tone: 'muted' },
  COMPLETED: { label: 'Completed', tone: 'neutral' },
};

const OFFERING_STATUS_BADGE: Readonly<Record<OfferingStatus, { readonly label: string; readonly tone: StatusBadgeTone }>> = {
  DRAFT: { label: 'Draft', tone: 'neutral' },
  PUBLISHED: { label: 'Published', tone: 'accent' },
  ARCHIVED: { label: 'Archived', tone: 'muted' },
};

// Mirrors class-listing.tsx's dayKeyFormatter/dayHeadingFormatter, pinned to
// the same CAFE_TIME_ZONE constant that surface exports — a class scheduled
// here must group under the same calendar day it shows customers on /book.
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

const timeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: CAFE_TIME_ZONE,
  hour: 'numeric',
  minute: '2-digit',
});

type DayGroup = readonly [dayKey: string, occurrences: readonly AdminOccurrenceView[]];

function groupByDay(occurrences: readonly AdminOccurrenceView[]): readonly DayGroup[] {
  const groups = new Map<string, AdminOccurrenceView[]>();

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

function capacityLabel(bookedSeats: number, capacity: number): { readonly text: string; readonly overCapacity: boolean } {
  if (bookedSeats > capacity) {
    return { text: `${bookedSeats} / ${capacity} booked — ${bookedSeats - capacity} over capacity`, overCapacity: true };
  }
  return { text: `${bookedSeats} / ${capacity} booked`, overCapacity: false };
}

export default async function AdminSchedulesPage() {
  const [occurrences, offerings] = await Promise.all([listUpcomingOccurrences(), listOfferings()]);
  const groups = groupByDay(occurrences);

  return (
    <PageShell
      title="Schedules"
      description="Put a published class on the calendar. Scheduling here is what makes it purchasable on /book."
    >
      <div className="flex flex-col gap-8">
        <section className="flex flex-col gap-3 rounded-lg border border-surface-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-surface-900">Schedule a class</h3>
          <ScheduleForm offerings={offerings} />
        </section>

        {groups.length === 0 ? (
          <EmptyState
            title="No occurrences scheduled"
            description="Schedule a class above to put it on the calendar."
          />
        ) : (
          <div className="flex flex-col gap-6">
            {groups.map(([dayKey, dayOccurrences]) => (
              <div key={dayKey} className="flex flex-col gap-3">
                <h2 className="text-sm font-semibold text-surface-700">
                  {dayHeadingFormatter.format(dayOccurrences[0]!.startsAt)}
                </h2>
                <ul className="flex flex-col gap-3">
                  {dayOccurrences.map((occurrence) => {
                    const occurrenceBadge = OCCURRENCE_STATUS_BADGE[occurrence.status];
                    const offeringBadge = OFFERING_STATUS_BADGE[occurrence.offeringStatus];
                    const { text: bookedText, overCapacity } = capacityLabel(occurrence.bookedSeats, occurrence.capacity);

                    return (
                      <li
                        key={occurrence.occurrenceId}
                        className="flex flex-col gap-2 rounded-lg border border-surface-200 bg-white p-4"
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex flex-col gap-1">
                            <div className="flex items-center gap-2">
                              <h3 className="text-sm font-semibold text-surface-900">{occurrence.offeringName}</h3>
                              <StatusBadge label={occurrenceBadge.label} tone={occurrenceBadge.tone} />
                            </div>
                            <p className="text-xs text-surface-600">
                              <time dateTime={occurrence.startsAt.toISOString()}>
                                {timeFormatter.format(occurrence.startsAt)}
                              </time>
                              {' – '}
                              <time dateTime={occurrence.endsAt.toISOString()}>
                                {timeFormatter.format(occurrence.endsAt)}
                              </time>
                            </p>
                          </div>
                          <p className={overCapacity ? 'text-sm font-semibold text-destructive-700' : 'text-sm text-surface-600'}>
                            {bookedText}
                          </p>
                        </div>

                        {occurrence.offeringStatus !== 'PUBLISHED' && (
                          <p className="flex items-center gap-2 text-xs text-surface-600">
                            <StatusBadge label={offeringBadge.label} tone={offeringBadge.tone} />
                            Not visible to customers — the offering is not published.
                          </p>
                        )}

                        <OccurrenceRow occurrence={occurrence} />
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </PageShell>
  );
}
