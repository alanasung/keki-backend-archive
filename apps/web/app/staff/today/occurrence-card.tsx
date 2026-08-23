import Link from 'next/link';
import { CAFE_TIME_ZONE } from '@keki/contracts';
import type { StaffOccurrenceView } from '@keki/staff-ops';
import { CountMeter, StatusBadge } from '@keki/ui';

export interface OccurrenceCardProps {
  readonly occurrence: StaffOccurrenceView;
  readonly now: Date;
}

const timeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: CAFE_TIME_ZONE,
  hour: 'numeric',
  minute: '2-digit',
});

export function OccurrenceCard({ occurrence, now }: OccurrenceCardProps) {
  const inProgress = occurrence.startsAt.getTime() <= now.getTime() && now.getTime() < occurrence.endsAt.getTime();
  const everyoneHere =
    occurrence.expectedParticipants > 0 && occurrence.arrivedParticipants === occurrence.expectedParticipants;

  // The whole card is the link target, not a small "check in" affordance —
  // getting to the roster for the class in front of you is the entire point
  // of this screen.
  return (
    <Link
      href={`/staff/check-in?occurrenceId=${occurrence.occurrenceId}`}
      className={
        inProgress
          ? 'flex flex-col gap-2 rounded-lg border border-brand-500 bg-white p-4 ring-1 ring-brand-500 transition hover:bg-surface-50'
          : 'flex flex-col gap-2 rounded-lg border border-surface-200 bg-white p-4 transition hover:bg-surface-50'
      }
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-surface-900">{occurrence.offeringName}</h3>
            {inProgress && <StatusBadge label="In progress" tone="accent" />}
          </div>
          <p className="text-xs text-surface-600">
            <time dateTime={occurrence.startsAt.toISOString()}>{timeFormatter.format(occurrence.startsAt)}</time>
            {' – '}
            <time dateTime={occurrence.endsAt.toISOString()}>{timeFormatter.format(occurrence.endsAt)}</time>
          </p>
        </div>
        <CountMeter arrived={occurrence.arrivedParticipants} expected={occurrence.expectedParticipants} />
      </div>
      {everyoneHere && <p className="text-xs font-medium text-brand-700">Everyone here</p>}
    </Link>
  );
}
