'use client';

import { useId, useMemo, useState, useTransition, type FormEvent } from 'react';
import Link from 'next/link';
import type { Offering } from '@keki/contracts';
import { FormField } from '@keki/ui';
import { scheduleOccurrenceAction } from '../actions/occurrence-actions';

export interface ScheduleFormProps {
  readonly offerings: readonly Offering[];
}

const INPUT_CLASS =
  'w-full rounded-md border border-surface-200 bg-white px-3 py-2 text-sm text-surface-900 ' +
  'placeholder:text-surface-400 focus:border-brand-500 focus:outline-none';

// No timeZone specified: this reads a browser-local datetime-local value and
// must format in that same (unspecified) zone, so the displayed end matches
// the wall-clock start the manager just typed rather than reinterpreting it.
const endTimeFormatter = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });

export function ScheduleForm({ offerings }: ScheduleFormProps) {
  const fieldId = useId();

  // Offering one would be a guaranteed refusal — WS-03 refuses to schedule
  // an occurrence against a draft or archived offering.
  const publishedOfferings = useMemo(
    () => offerings.filter((offering) => offering.status === 'PUBLISHED'),
    [offerings],
  );

  const [offeringId, setOfferingId] = useState(publishedOfferings[0]?.id ?? '');
  const [startsAt, setStartsAt] = useState('');
  const [capacityOverride, setCapacityOverride] = useState('');
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const selectedOffering = publishedOfferings.find((offering) => offering.id === offeringId);
  const parsedStart = startsAt !== '' ? new Date(startsAt) : null;
  const computedEnd =
    selectedOffering !== undefined && parsedStart !== null && !Number.isNaN(parsedStart.getTime())
      ? new Date(parsedStart.getTime() + selectedOffering.durationMinutes * 60_000)
      : null;

  if (publishedOfferings.length === 0) {
    return (
      <p className="text-sm text-surface-600">
        No published offerings yet.{' '}
        <Link href="/admin/offerings" className="font-medium text-brand-600 underline">
          Publish one on Offerings
        </Link>{' '}
        before scheduling a class.
      </p>
    );
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setError(null);

    if (selectedOffering === undefined || parsedStart === null || Number.isNaN(parsedStart.getTime())) {
      return;
    }

    // WS-01's schema coerces this back into a Date; a string is what
    // survives the trip through a Server Action's serialization boundary.
    const payload = {
      offeringId: selectedOffering.id,
      startsAt: parsedStart.toISOString(),
      capacityOverride: capacityOverride.trim() === '' ? null : Number(capacityOverride),
    };

    startTransition(async () => {
      const result = await scheduleOccurrenceAction(payload);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setStartsAt('');
      setCapacityOverride('');
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <FormField label="Offering" htmlFor={`${fieldId}-offering`}>
        <select
          id={`${fieldId}-offering`}
          className={INPUT_CLASS}
          value={offeringId}
          onChange={(event) => setOfferingId(event.target.value)}
        >
          {publishedOfferings.map((offering) => (
            <option key={offering.id} value={offering.id}>
              {offering.name}
            </option>
          ))}
        </select>
      </FormField>

      <FormField label="Start" htmlFor={`${fieldId}-starts-at`}>
        <input
          id={`${fieldId}-starts-at`}
          type="datetime-local"
          className={INPUT_CLASS}
          value={startsAt}
          onChange={(event) => setStartsAt(event.target.value)}
        />
      </FormField>

      {/* No end-time field: WS-03 derives it from the offering's duration. */}
      {computedEnd !== null && (
        <p className="text-xs text-surface-600">Ends at {endTimeFormatter.format(computedEnd)}</p>
      )}

      <FormField
        label="Capacity override"
        htmlFor={`${fieldId}-capacity`}
        hint="Optional — defaults to the offering's capacity."
      >
        <input
          id={`${fieldId}-capacity`}
          type="number"
          className={INPUT_CLASS}
          value={capacityOverride}
          onChange={(event) => setCapacityOverride(event.target.value)}
        />
      </FormField>

      {error !== null && (
        <p role="alert" className="rounded-md bg-destructive-50 px-3 py-2 text-sm text-destructive-700">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={isPending}
        className="self-start rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-60"
      >
        {isPending ? 'Scheduling…' : 'Schedule'}
      </button>
    </form>
  );
}
