import { CAFE_TIME_ZONE } from '@keki/contracts';

// `en-CA` renders as `YYYY-MM-DD`, the same trick class-listing.tsx uses to
// group occurrences by local calendar day.
const localDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: CAFE_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

interface LocalDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function localDateOf(instant: Date): LocalDate {
  const [year, month, day] = localDateFormatter.format(instant).split('-').map(Number);
  return { year: year!, month: month!, day: day! };
}

// The UTC offset a zone applies to a given instant, expressed as
// "what local wall-clock time does this instant render as, minus the
// instant itself" — e.g. -7h during America/Los_Angeles' summer (PDT).
function utcOffsetMillisAt(instant: Date, timeZone: string): number {
  const parts: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant)) {
    if (part.type !== 'literal') {
      parts[part.type] = part.value;
    }
  }

  const asIfUtc = Date.UTC(
    Number(parts['year']),
    Number(parts['month']) - 1,
    Number(parts['day']),
    Number(parts['hour']),
    Number(parts['minute']),
    Number(parts['second']),
  );
  return asIfUtc - instant.getTime();
}

// Resolves local midnight on `date` (in `timeZone`) to the UTC instant it
// names. Not a fixed offset: the offset is sampled at a guess instant close
// to the target, which is exact except within the DST transition itself —
// irrelevant here since US transitions land at 2am local, never midnight.
function localMidnightToUtc(date: LocalDate, timeZone: string): Date {
  const guessMillis = Date.UTC(date.year, date.month - 1, date.day, 0, 0, 0);
  const offsetMillis = utcOffsetMillisAt(new Date(guessMillis), timeZone);
  return new Date(guessMillis - offsetMillis);
}

/**
 * The UTC instants bracketing the cafe's calendar day (`CAFE_TIME_ZONE`)
 * containing `now`. Half-open: `[start, end)`, so an occurrence at exactly
 * `end` belongs to the next day and one at exactly `start` belongs to this
 * one.
 */
export function cafeDayBounds(now: Date): { start: Date; end: Date } {
  const today = localDateOf(now);
  const start = localMidnightToUtc(today, CAFE_TIME_ZONE);
  const end = localMidnightToUtc({ year: today.year, month: today.month, day: today.day + 1 }, CAFE_TIME_ZONE);
  return { start, end };
}
