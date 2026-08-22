import Link from 'next/link';
import { notFound } from 'next/navigation';
import { listUpcomingOccurrences, type AdminOccurrenceView } from '@keki/catalog-admin';
import { listReservationsForOccurrence } from '@keki/reservation-core';
import { createOccurrenceId, type OccurrenceId } from '@keki/contracts';
import { EmptyState, PageShell } from '@keki/ui';
import { CAFE_TIME_ZONE } from '../../(customer)/book/class-listing';
import { OccurrenceRoster, resolveRoster } from './occurrence-roster';

// Staff pull this page up mid-conversation with a customer — it must show
// who is booked right now, not a stale route-cache snapshot.
export const dynamic = 'force-dynamic';

interface AdminReservationsPageProps {
  readonly searchParams: Promise<{ readonly occurrenceId?: string }>;
}

const timeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: CAFE_TIME_ZONE,
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function earliestOccurrence(occurrences: readonly AdminOccurrenceView[]): AdminOccurrenceView {
  return [...occurrences].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())[0]!;
}

export default async function AdminReservationsPage({ searchParams }: AdminReservationsPageProps) {
  const params = await searchParams;
  const occurrences = await listUpcomingOccurrences();

  if (occurrences.length === 0) {
    return (
      <PageShell
        title="Reservations"
        description="See who is booked on an occurrence, with participant names. Read-only — check-in and edits belong to the staff surface."
      >
        <EmptyState
          title="No upcoming occurrences"
          description="Schedule a class on /admin/schedules to see its roster here."
        />
      </PageShell>
    );
  }

  // A roster is linkable — staff send one to a colleague — so the selected
  // occurrence comes from the URL, not client state, and defaults to the
  // next upcoming one rather than an empty chooser.
  let occurrenceId: OccurrenceId;
  if (params.occurrenceId !== undefined) {
    try {
      occurrenceId = createOccurrenceId(params.occurrenceId);
    } catch {
      notFound();
    }
  } else {
    occurrenceId = earliestOccurrence(occurrences).occurrenceId;
  }

  const selected = occurrences.find((occurrence) => occurrence.occurrenceId === occurrenceId);
  if (selected === undefined) {
    notFound();
  }

  const reservations = await listReservationsForOccurrence(selected.occurrenceId);
  const roster = await resolveRoster(reservations);

  return (
    <PageShell
      title="Reservations"
      description="See who is booked on an occurrence, with participant names. Read-only — check-in and edits belong to the staff surface."
    >
      <div className="flex flex-col gap-6 lg:flex-row">
        <nav aria-label="Upcoming occurrences" className="flex flex-col gap-2 lg:w-72">
          <ul className="flex flex-col gap-2">
            {occurrences.map((occurrence) => {
              const isSelected = occurrence.occurrenceId === selected.occurrenceId;
              return (
                <li key={occurrence.occurrenceId}>
                  <Link
                    href={{ pathname: '/admin/reservations', query: { occurrenceId: occurrence.occurrenceId } }}
                    aria-current={isSelected ? 'page' : undefined}
                    className={`flex flex-col gap-0.5 rounded-lg border p-3 text-sm transition ${
                      isSelected
                        ? 'border-brand-500 bg-brand-50 text-brand-900'
                        : 'border-surface-200 bg-white text-surface-800 hover:border-brand-300'
                    }`}
                  >
                    <span className="font-medium">{occurrence.offeringName}</span>
                    <time dateTime={occurrence.startsAt.toISOString()} className="text-xs text-surface-600">
                      {timeFormatter.format(occurrence.startsAt)}
                    </time>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="flex-1">
          <OccurrenceRoster occurrence={selected} roster={roster} />
        </div>
      </div>
    </PageShell>
  );
}
