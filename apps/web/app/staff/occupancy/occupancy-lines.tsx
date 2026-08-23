import { CAFE_TIME_ZONE } from '@keki/contracts';
import type { OccupancyLine } from '@keki/staff-ops';

export interface OccupancyLinesProps {
  readonly lines: readonly OccupancyLine[];
}

const endsAtFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: CAFE_TIME_ZONE,
  hour: 'numeric',
  minute: '2-digit',
});

// One line per in-progress occurrence. The end time is what tells staff
// when those people stop counting — it turns an opaque number into one
// they can predict, rather than one they just have to trust.
export function OccupancyLines({ lines }: OccupancyLinesProps) {
  return (
    <ul className="flex flex-col gap-2">
      {lines.map((line) => (
        <li
          key={line.occurrenceId}
          className="flex items-center justify-between gap-4 rounded-lg border border-surface-200 bg-white p-4"
        >
          <span className="text-sm font-semibold text-surface-900">{line.offeringName}</span>
          <div className="flex items-center gap-4 text-sm text-surface-600">
            <span>{line.headcount}</span>
            <span>
              Ends <time dateTime={line.endsAt.toISOString()}>{endsAtFormatter.format(line.endsAt)}</time>
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}
