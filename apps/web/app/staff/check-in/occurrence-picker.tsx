import Link from 'next/link';
import { CAFE_TIME_ZONE, type OccurrenceId } from '@keki/contracts';
import type { StaffOccurrenceView } from '@keki/staff-ops';

export interface OccurrencePickerProps {
  readonly occurrences: readonly StaffOccurrenceView[];
  readonly selectedOccurrenceId: OccurrenceId | null;
}

const timeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: CAFE_TIME_ZONE,
  hour: 'numeric',
  minute: '2-digit',
});

// Lets a staff member switch classes without going back to /staff/today.
// Scoped to today only — a roster from yesterday or next week is not a
// class anyone is standing in front of right now.
export function OccurrencePicker({ occurrences, selectedOccurrenceId }: OccurrencePickerProps) {
  if (occurrences.length === 0) {
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-dashed border-surface-300 bg-surface-50 p-6 lg:w-72">
        <p className="text-sm font-semibold text-surface-700">Nothing scheduled today</p>
        <p className="text-sm text-surface-500">
          There are no classes today to check people in for.{' '}
          <Link href="/staff/today" className="font-medium text-brand-700 underline">
            See today&apos;s schedule
          </Link>
          .
        </p>
      </div>
    );
  }

  return (
    <nav aria-label="Today's occurrences" className="flex flex-col gap-2 lg:w-72">
      <ul className="flex flex-col gap-2">
        {occurrences.map((occurrence) => {
          const isSelected = occurrence.occurrenceId === selectedOccurrenceId;
          return (
            <li key={occurrence.occurrenceId}>
              <Link
                href={{ pathname: '/staff/check-in', query: { occurrenceId: occurrence.occurrenceId } }}
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
  );
}
