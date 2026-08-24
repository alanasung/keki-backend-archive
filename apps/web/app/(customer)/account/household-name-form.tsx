'use client';

import { useId, useState, useTransition, type FormEvent } from 'react';
import { FormField } from '@keki/ui';
import { updateHouseholdNameAction } from './account-actions';

export interface HouseholdNameFormProps {
  readonly currentName: string;
}

const INPUT_CLASS =
  'w-full rounded-md border border-surface-200 bg-white px-3 py-2 text-sm text-surface-900 ' +
  'placeholder:text-surface-400 focus:border-brand-500 focus:outline-none disabled:opacity-60';

export function HouseholdNameForm({ currentName }: HouseholdNameFormProps) {
  const fieldId = useId();
  const [name, setName] = useState(currentName);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setError(null);
    // A silent rename reads as a no-op, so clear any earlier confirmation
    // before this submission has a result of its own.
    setSaved(false);

    startTransition(async () => {
      const result = await updateHouseholdNameAction({ name });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setSaved(true);
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <FormField label="Household name" htmlFor={`${fieldId}-household-name`}>
        <input
          id={`${fieldId}-household-name`}
          className={INPUT_CLASS}
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={isPending}
        />
      </FormField>

      {error !== null && (
        <p role="alert" className="rounded-md bg-destructive-50 px-3 py-2 text-sm text-destructive-700">
          {error}
        </p>
      )}

      {saved && (
        <p role="status" className="text-sm text-emerald-700">
          Household name updated.
        </p>
      )}

      <button
        type="submit"
        disabled={isPending}
        className="self-start rounded-lg border border-surface-300 bg-white px-4 py-2 text-sm font-semibold text-surface-900 transition hover:border-brand-500 disabled:opacity-60"
      >
        {isPending ? 'Saving…' : 'Save'}
      </button>
    </form>
  );
}
