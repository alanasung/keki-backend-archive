'use client';

import { useState, useTransition } from 'react';
import { ParticipantChecklist, type ParticipantChecklistOption } from '@keki/ui';
import { cartParticipantRefKey, type CartParticipantRef, type HouseholdMemberView, type OccurrenceId } from '@keki/contracts';
import { addClassSeatsAction } from '../cart/actions';

export interface ParticipantPickerProps {
  readonly occurrenceId: OccurrenceId;
  readonly members: readonly HouseholdMemberView[];
  // Display-only and stale on arrival — see class-listing.tsx. Disabling
  // selection past this is a courtesy, never the authoritative check; a
  // CONFLICT from WS-05's real capacity check at checkout is still possible
  // and is surfaced through the same error rendering below as any other
  // action failure.
  readonly seatsRemaining: number;
}

export function ParticipantPicker({ occurrenceId, members, seatsRemaining }: ParticipantPickerProps) {
  const [selected, setSelected] = useState<readonly CartParticipantRef[]>([]);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState(false);

  const refByKey = new Map(members.map((member) => [cartParticipantRefKey(member.ref), member.ref]));
  const options: readonly ParticipantChecklistOption[] = members.map((member) => ({
    id: cartParticipantRefKey(member.ref),
    displayName: member.displayName,
  }));
  const selectedIds = selected.map((ref) => cartParticipantRefKey(ref));

  function toggle(id: string): void {
    setAdded(false);
    setSelected((current) => {
      if (current.some((ref) => cartParticipantRefKey(ref) === id)) {
        return current.filter((ref) => cartParticipantRefKey(ref) !== id);
      }
      const ref = refByKey.get(id);
      return ref === undefined ? current : [...current, ref];
    });
  }

  function handleSubmit(): void {
    setError(null);
    startTransition(async () => {
      const result = await addClassSeatsAction({ occurrenceId, participants: selected });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setAdded(true);
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <ParticipantChecklist
        options={options}
        selectedIds={selectedIds}
        onToggle={toggle}
        maxSelectable={seatsRemaining}
      />
      <button
        type="button"
        onClick={handleSubmit}
        disabled={isPending || selected.length === 0}
        className="self-start rounded bg-surface-900 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
      >
        {isPending ? 'Booking…' : 'Book seats'}
      </button>
      {error !== null && (
        <p role="alert" className="text-xs text-red-600">
          {error}
        </p>
      )}
      {added && (
        <p role="status" className="text-xs text-emerald-700">
          Seats added to cart.
        </p>
      )}
    </div>
  );
}
