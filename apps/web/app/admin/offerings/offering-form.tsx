'use client';

import { useId, useState, useTransition, type FormEvent } from 'react';
import type { Offering } from '@keki/contracts';
import { FormField } from '@keki/ui';
import { createOfferingAction, updateOfferingAction } from '../actions/offering-actions';

export interface OfferingFormProps {
  // Omitted for create, present for edit — the same fields either way, so
  // one component (and one boundary conversion) serves both rather than
  // duplicating the dollars-to-cents parsing in a second file.
  readonly offering?: Offering;
  readonly onSuccess?: () => void;
}

const INPUT_CLASS =
  'w-full rounded-md border border-surface-200 bg-white px-3 py-2 text-sm text-surface-900 ' +
  'placeholder:text-surface-400 focus:border-brand-500 focus:outline-none';

export function OfferingForm({ offering, onSuccess }: OfferingFormProps) {
  const isEdit = offering !== undefined;
  const fieldId = useId();

  const [name, setName] = useState(offering?.name ?? '');
  const [description, setDescription] = useState(offering?.description ?? '');
  const [durationMinutes, setDurationMinutes] = useState(
    offering !== undefined ? String(offering.durationMinutes) : '',
  );
  const [defaultCapacity, setDefaultCapacity] = useState(
    offering !== undefined ? String(offering.defaultCapacity) : '',
  );
  // Managers think in dollars; the input stays a dollar string end to end
  // and is converted to integer cents only at submit time, at the boundary
  // to the action.
  const [priceDollars, setPriceDollars] = useState(
    offering !== undefined ? (offering.priceCents / 100).toFixed(2) : '',
  );
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setError(null);

    const trimmedDescription = description.trim();
    const payload = {
      name,
      description: trimmedDescription === '' ? null : trimmedDescription,
      type: 'CLASS' as const,
      durationMinutes: Number(durationMinutes),
      defaultCapacity: Number(defaultCapacity),
      // Explicit conversion, never a float passed through: a fractional
      // cent would corrupt every downstream total.
      priceCents: Math.round(Number(priceDollars) * 100),
      currency: 'USD',
    };

    startTransition(async () => {
      const result =
        offering !== undefined
          ? await updateOfferingAction({ offeringId: offering.id, data: payload })
          : await createOfferingAction(payload);

      if (!result.ok) {
        setError(result.error.message);
        return;
      }

      if (offering === undefined) {
        setName('');
        setDescription('');
        setDurationMinutes('');
        setDefaultCapacity('');
        setPriceDollars('');
      }
      onSuccess?.();
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <FormField label="Name" htmlFor={`${fieldId}-name`}>
        <input
          id={`${fieldId}-name`}
          className={INPUT_CLASS}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </FormField>

      <FormField label="Description" htmlFor={`${fieldId}-description`} hint="Optional">
        <textarea
          id={`${fieldId}-description`}
          className={INPUT_CLASS}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </FormField>

      <FormField label="Duration (minutes)" htmlFor={`${fieldId}-duration`}>
        <input
          id={`${fieldId}-duration`}
          type="number"
          className={INPUT_CLASS}
          value={durationMinutes}
          onChange={(event) => setDurationMinutes(event.target.value)}
        />
      </FormField>

      <FormField label="Capacity" htmlFor={`${fieldId}-capacity`}>
        <input
          id={`${fieldId}-capacity`}
          type="number"
          className={INPUT_CLASS}
          value={defaultCapacity}
          onChange={(event) => setDefaultCapacity(event.target.value)}
        />
      </FormField>

      <FormField label="Price (USD)" htmlFor={`${fieldId}-price`} hint="Dollars, e.g. 45.00">
        <input
          id={`${fieldId}-price`}
          type="number"
          step="0.01"
          className={INPUT_CLASS}
          value={priceDollars}
          onChange={(event) => setPriceDollars(event.target.value)}
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
        {isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Create offering'}
      </button>
    </form>
  );
}
