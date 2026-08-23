import { describe, expect, it } from 'vitest';
import { cafeDayBounds } from './day-boundaries';

describe('cafeDayBounds', () => {
  it('brackets the local calendar day for an instant at 14:00 local (test 1)', () => {
    // 2026-08-19T14:00:00 in America/Los_Angeles (PDT, UTC-7) is 21:00 UTC.
    const now = new Date('2026-08-19T21:00:00Z');

    const { start, end } = cafeDayBounds(now);

    expect(start.toISOString()).toBe('2026-08-19T07:00:00.000Z');
    expect(end.toISOString()).toBe('2026-08-20T07:00:00.000Z');
  });

  it('maps a UTC instant belonging to the previous local day correctly (test 2, SC-02)', () => {
    // 2026-08-22T04:00:00Z is 21:00 on 2026-08-21 in America/Los_Angeles.
    const now = new Date('2026-08-22T04:00:00Z');

    const { start, end } = cafeDayBounds(now);

    expect(start.toISOString()).toBe('2026-08-21T07:00:00.000Z');
    expect(end.toISOString()).toBe('2026-08-22T07:00:00.000Z');
  });

  it('is correct across the spring DST boundary: the day is 23 hours long (test 3)', () => {
    // 2026-03-08 is the US spring-forward date (clocks jump 2am -> 3am PST -> PDT).
    const now = new Date('2026-03-08T20:00:00Z');

    const { start, end } = cafeDayBounds(now);

    expect(end.getTime() - start.getTime()).toBe(23 * 60 * 60 * 1000);
  });

  it('is correct across the autumn DST boundary: the day is 25 hours long (test 4)', () => {
    // 2026-11-01 is the US fall-back date (clocks fall 2am -> 1am PDT -> PST).
    const now = new Date('2026-11-01T20:00:00Z');

    const { start, end } = cafeDayBounds(now);

    expect(end.getTime() - start.getTime()).toBe(25 * 60 * 60 * 1000);
  });

  it('the bounds are half-open: start is included, end belongs to the next day (test 5)', () => {
    const { start, end } = cafeDayBounds(new Date('2026-08-19T21:00:00Z'));

    // An instant at exactly `start` maps to a day whose own start is that
    // same instant — it is included in this day, not the previous one.
    expect(cafeDayBounds(start).start.getTime()).toBe(start.getTime());

    // An instant at exactly `end` maps to a day whose start is that same
    // instant — it belongs to the next day, so it is excluded from this one.
    expect(cafeDayBounds(end).start.getTime()).toBe(end.getTime());
  });
});
