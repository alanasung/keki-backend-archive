'use client';

import { useId, useState, useTransition, type FormEvent } from 'react';
import { FormField } from '@keki/ui';
import { addChildAction } from './account-actions';

const INPUT_CLASS =
  'w-full rounded-md border border-surface-200 bg-white px-3 py-2 text-sm text-surface-900 ' +
  'placeholder:text-surface-400 focus:border-brand-500 focus:outline-none disabled:opacity-60';

// Local calendar-day parts, not `toISOString().slice(0, 10)`: the latter
// normalizes through UTC first, which would roll a late-evening local
// "today" into tomorrow and let a browser accept a birthday that hasn't
// happened yet on the customer's own clock.
function todayDateString(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function AddChildForm() {
  const fieldId = useId();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const maxDate = todayDateString();

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setError(null);

    startTransition(async () => {
      const result = await addChildAction({ firstName, lastName, dateOfBirth });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setFirstName('');
      setLastName('');
      setDateOfBirth('');
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <FormField label="First name" htmlFor={`${fieldId}-first-name`}>
        <input
          id={`${fieldId}-first-name`}
          className={INPUT_CLASS}
          value={firstName}
          onChange={(event) => setFirstName(event.target.value)}
          disabled={isPending}
        />
      </FormField>

      <FormField label="Last name" htmlFor={`${fieldId}-last-name`}>
        <input
          id={`${fieldId}-last-name`}
          className={INPUT_CLASS}
          value={lastName}
          onChange={(event) => setLastName(event.target.value)}
          disabled={isPending}
        />
      </FormField>

      <FormField label="Date of birth" htmlFor={`${fieldId}-date-of-birth`}>
        {/* `type="date"` and `max` are courtesies, not the guard: the schema
            and the command both refuse a future date too. See
            addChildSchema (WS-01) and addChild (WS-06). */}
        <input
          id={`${fieldId}-date-of-birth`}
          type="date"
          max={maxDate}
          className={INPUT_CLASS}
          value={dateOfBirth}
          onChange={(event) => setDateOfBirth(event.target.value)}
          disabled={isPending}
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
        {isPending ? 'Adding…' : 'Add child'}
      </button>
    </form>
  );
}
