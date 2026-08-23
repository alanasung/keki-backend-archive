import { CAFE_TIME_ZONE } from '@keki/contracts';
import { listTodaysOccurrences } from '@keki/staff-ops';
import { EmptyState, PageShell } from '@keki/ui';
import { OccurrenceCard } from './occurrence-card';

// Mirrors admin/schedules's dayHeadingFormatter, pinned to the same
// CAFE_TIME_ZONE constant — a staff member opening this at 11pm should see
// which cafe-local day they're looking at, not the server's.
const dayHeadingFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: CAFE_TIME_ZONE,
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
});

export default async function StaffTodayPage() {
  const now = new Date();
  const occurrences = await listTodaysOccurrences({ now });
  // Re-sorted here rather than trusted from the query — the in-progress
  // occurrence is sorted into place chronologically, not pinned, so the
  // list must not depend on read order.
  const sorted = [...occurrences].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());

  return (
    <PageShell title={dayHeadingFormatter.format(now)} description="Today's schedule and who has arrived.">
      {sorted.length === 0 ? (
        <EmptyState
          title="Nothing scheduled today"
          description="There are no classes on the calendar for today."
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {sorted.map((occurrence) => (
            <li key={occurrence.occurrenceId}>
              <OccurrenceCard occurrence={occurrence} now={now} />
            </li>
          ))}
        </ul>
      )}
    </PageShell>
  );
}
