'use client';

import { useId, useState, useTransition, type FormEvent } from 'react';
import { FormField } from '@keki/ui';
import { completeProfileAction } from './complete-profile-action';

export interface ProfileFormProps {
  readonly email: string | undefined;
  readonly givenName: string | undefined;
  readonly familyName: string | undefined;
}

const INPUT_CLASS =
  'w-full rounded-md border border-surface-200 bg-white px-3 py-2 text-sm text-surface-900 ' +
  'placeholder:text-surface-400 focus:border-brand-500 focus:outline-none disabled:opacity-60';

// Pre-filled from Cognito's `given_name`/`family_name` claims when the
// hosted UI's sign-up form collected them, but always editable — that form
// is not necessarily where someone wants their name to come from. A missing
// claim degrades to an empty string, never `undefined`, so these stay
// controlled inputs from the first render.
export function ProfileForm({ email, givenName, familyName }: ProfileFormProps) {
  const fieldId = useId();
  const [firstName, setFirstName] = useState(givenName ?? '');
  const [lastName, setLastName] = useState(familyName ?? '');
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setError(null);

    startTransition(async () => {
      const result = await completeProfileAction({ firstName, lastName });
      if (!result.ok) {
        setError(result.error.message);
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-surface-800">Email</span>
        {/* Read-only: the address comes from the verified token, and
            `completeProfileSchema` has no field for it, so an editable
            control here would invite an expectation editing it does
            something. */}
        <p className="text-sm text-surface-600">{email ?? ''}</p>
      </div>

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
        {isPending ? 'Saving…' : 'Complete profile'}
      </button>
    </form>
  );
}
