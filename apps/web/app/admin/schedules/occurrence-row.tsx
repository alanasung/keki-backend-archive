'use client';

import { useId, useState, useTransition, type FormEvent } from 'react';
import type { AdminOccurrenceView } from '@keki/catalog-admin';
import { FormField } from '@keki/ui';
import { cancelOccurrenceAction, updateOccurrenceAction } from '../actions/occurrence-actions';

export interface OccurrenceRowProps {
  readonly occurrence: AdminOccurrenceView;
}

const INPUT_CLASS =
  'w-full rounded-md border border-surface-200 bg-white px-3 py-2 text-sm text-surface-900 ' +
  'placeholder:text-surface-400 focus:border-brand-500 focus:outline-none';
const SECONDARY_BUTTON_CLASS =
  'rounded-md border border-surface-300 px-3 py-1.5 text-xs font-medium text-surface-800 ' +
  'transition hover:bg-surface-100 disabled:opacity-50';
const PRIMARY_BUTTON_CLASS =
  'rounded-md bg-brand-500 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50';
const DANGER_BUTTON_CLASS =
  'rounded-md bg-destructive-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-destructive-700 disabled:opacity-50';

export function OccurrenceRow({ occurrence }: OccurrenceRowProps) {
  const fieldId = useId();

  const [isEditingCapacity, setIsEditingCapacity] = useState(false);
  const [capacityInput, setCapacityInput] = useState(String(occurrence.capacity));
  const [capacityError, setCapacityError] = useState<string | null>(null);
  const [capacityWarning, setCapacityWarning] = useState<string | null>(null);
  const [isCapacityPending, startCapacityTransition] = useTransition();

  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [isCancelPending, startCancelTransition] = useTransition();

  function handleCapacitySubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setCapacityError(null);
    setCapacityWarning(null);

    const newCapacity = Number(capacityInput);

    startCapacityTransition(async () => {
      const result = await updateOccurrenceAction({
        occurrenceId: occurrence.occurrenceId,
        data: { capacityOverride: newCapacity },
      });

      if (!result.ok) {
        setCapacityError(result.error.message);
        return;
      }

      setIsEditingCapacity(false);
      // A permitted, deliberate outcome — not an error — so it renders as a
      // warning naming both numbers, never through the error path above.
      if (result.data.bookedSeats > newCapacity) {
        const excess = result.data.bookedSeats - newCapacity;
        setCapacityWarning(
          `Capacity updated to ${newCapacity}, but ${result.data.bookedSeats} are already booked — ${excess} over capacity.`,
        );
      }
    });
  }

  function handleCancel(): void {
    setCancelError(null);
    startCancelTransition(async () => {
      const result = await cancelOccurrenceAction({ occurrenceId: occurrence.occurrenceId });
      if (!result.ok) {
        setCancelError(result.error.message);
        return;
      }
      setConfirmingCancel(false);
    });
  }

  // The server would refuse a transition out of CANCELLED — offering a
  // control it will refuse is worse than not offering it.
  if (occurrence.status === 'CANCELLED') {
    return <p className="text-xs text-surface-500">This occurrence is cancelled.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={SECONDARY_BUTTON_CLASS}
          onClick={() => setIsEditingCapacity((current) => !current)}
        >
          {isEditingCapacity ? 'Cancel edit' : 'Edit capacity'}
        </button>

        {confirmingCancel ? (
          <span className="flex items-center gap-2">
            <span className="text-xs text-surface-600">
              Cancel this class? It will be removed from the customer booking page.
            </span>
            <button type="button" className={DANGER_BUTTON_CLASS} disabled={isCancelPending} onClick={handleCancel}>
              Confirm cancel
            </button>
            <button type="button" className={SECONDARY_BUTTON_CLASS} onClick={() => setConfirmingCancel(false)}>
              Never mind
            </button>
          </span>
        ) : (
          <button type="button" className={SECONDARY_BUTTON_CLASS} onClick={() => setConfirmingCancel(true)}>
            Cancel class
          </button>
        )}
      </div>

      {cancelError !== null && (
        <p role="alert" className="text-xs text-destructive-700">
          {cancelError}
        </p>
      )}

      {isEditingCapacity && (
        <form
          onSubmit={handleCapacitySubmit}
          className="flex items-end gap-2 rounded-md border border-surface-200 bg-surface-50 p-3"
        >
          <FormField label="Capacity" htmlFor={`${fieldId}-capacity`}>
            <input
              id={`${fieldId}-capacity`}
              type="number"
              className={INPUT_CLASS}
              value={capacityInput}
              onChange={(event) => setCapacityInput(event.target.value)}
            />
          </FormField>
          <button type="submit" disabled={isCapacityPending} className={PRIMARY_BUTTON_CLASS}>
            {isCapacityPending ? 'Saving…' : 'Save'}
          </button>
        </form>
      )}

      {capacityError !== null && (
        <p role="alert" className="text-xs text-destructive-700">
          {capacityError}
        </p>
      )}

      {capacityWarning !== null && (
        <p role="status" className="text-xs font-medium text-amber-700">
          {capacityWarning}
        </p>
      )}
    </div>
  );
}
