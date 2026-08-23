'use client';

import { useState, useTransition } from 'react';
import { CAFE_TIME_ZONE, type ReservationId, type ReservationParticipantId, type ReservationStatus } from '@keki/contracts';
import { checkInParticipantAction, markNoShowAction, undoCheckInParticipantAction } from '../actions/check-in-actions';

const timeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: CAFE_TIME_ZONE,
  hour: 'numeric',
  minute: '2-digit',
});

// Deliberately oversized: this is used one-handed on a tablet with a queue
// forming, and a small tap target is a mis-tap.
const CHECK_IN_BUTTON_CLASS =
  'rounded-xl bg-brand-500 px-8 py-5 text-lg font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50';
const SECONDARY_BUTTON_CLASS =
  'rounded-md border border-surface-300 px-3 py-1.5 text-xs font-medium text-surface-800 ' +
  'transition hover:bg-surface-100 disabled:opacity-50';
const DANGER_BUTTON_CLASS =
  'rounded-md bg-destructive-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-destructive-700 disabled:opacity-50';

export interface RosterRowProps {
  readonly participantId: ReservationParticipantId;
  readonly displayName: string;
  readonly isChild: boolean;
  readonly checkedInAt: Date | null;
}

// One per participant. Never unmounts on success — only its internal state
// changes — so a finger already headed toward this row's position cannot
// land on the next person's row instead.
export function RosterRow({ participantId, displayName, isChild, checkedInAt: initialCheckedInAt }: RosterRowProps) {
  const [checkedInAt, setCheckedInAt] = useState(initialCheckedInAt);
  const [isPending, startTransition] = useTransition();
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Which action is in flight, not merely that one is. `checkedInAt` flips as
  // soon as the action resolves, but the transition stays pending through
  // revalidation — so a lone `isPending` would render the freshly-swapped
  // Undo button as "Undoing…" immediately after a successful check-in,
  // claiming to reverse the thing that just happened. A staff member could
  // reasonably tap that to stop it and undo a legitimate arrival.
  const [pendingAction, setPendingAction] = useState<'check-in' | 'undo' | null>(null);
  const busy = isPending && pendingAction !== null;

  function handleCheckIn(): void {
    setNotice(null);
    setError(null);
    setPendingAction('check-in');
    startTransition(async () => {
      try {
        const result = await checkInParticipantAction({ reservationParticipantId: participantId });
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        setCheckedInAt(result.data.checkedInAt);
        // Two staff members tapping the same name is expected, not a failure.
        if (!result.data.changed) {
          setNotice('Already checked in.');
        }
      } finally {
        setPendingAction(null);
      }
    });
  }

  function handleUndo(): void {
    setNotice(null);
    setError(null);
    setPendingAction('undo');
    startTransition(async () => {
      try {
        const result = await undoCheckInParticipantAction({ reservationParticipantId: participantId });
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        setCheckedInAt(null);
      } finally {
        setPendingAction(null);
      }
    });
  }

  return (
    <li className="flex items-center justify-between gap-4 rounded-lg border border-surface-200 bg-white p-4">
      <div className="flex flex-col gap-1">
        <p className="text-base font-semibold text-surface-900">
          {displayName}
          {isChild && (
            <span className="ml-2 rounded-full bg-brand-100 px-2 py-0.5 text-xs font-medium text-brand-700">
              Child
            </span>
          )}
        </p>
        {checkedInAt !== null && (
          <p className="text-xs text-surface-600">
            Checked in at <time dateTime={checkedInAt.toISOString()}>{timeFormatter.format(checkedInAt)}</time>
          </p>
        )}
        {notice !== null && (
          <p role="status" className="text-xs font-medium text-surface-600">
            {notice}
          </p>
        )}
        {error !== null && (
          <p role="alert" className="text-xs text-destructive-700">
            {error}
          </p>
        )}
      </div>
      {checkedInAt === null ? (
        <button type="button" className={CHECK_IN_BUTTON_CLASS} disabled={busy} onClick={handleCheckIn}>
          {pendingAction === 'check-in' ? 'Checking in…' : 'Check in'}
        </button>
      ) : (
        <button type="button" className={SECONDARY_BUTTON_CLASS} disabled={busy} onClick={handleUndo}>
          {pendingAction === 'undo' ? 'Undoing…' : 'Undo'}
        </button>
      )}
    </li>
  );
}

export interface ReservationNoShowControlProps {
  readonly reservationId: ReservationId;
  readonly reservationStatus: ReservationStatus;
  readonly anyCheckedIn: boolean;
}

// Reservation-level, not participant-level: NO_SHOW is a status on the
// booking, not a per-person granularity the command has. Only a CONFIRMED
// reservation with nobody yet arrived is eligible (see staff-ops's
// NO_SHOW_ELIGIBLE_STATUSES) — offering the control anywhere else is
// offering an action the server will refuse.
export function ReservationNoShowControl({ reservationId, reservationStatus, anyCheckedIn }: ReservationNoShowControlProps) {
  const [confirming, setConfirming] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (reservationStatus !== 'CONFIRMED' || anyCheckedIn) {
    return null;
  }

  if (done) {
    return <p className="text-xs text-surface-600">Marked as no-show.</p>;
  }

  function handleConfirm(): void {
    setError(null);
    startTransition(async () => {
      const result = await markNoShowAction({ reservationId });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setConfirming(false);
      setDone(true);
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      {confirming ? (
        <div className="flex items-center gap-2">
          <span className="text-xs text-surface-600">
            Mark this booking as a no-show? This releases its seats back to the class.
          </span>
          <button type="button" className={DANGER_BUTTON_CLASS} disabled={isPending} onClick={handleConfirm}>
            {isPending ? 'Confirming…' : 'Confirm no-show'}
          </button>
          <button type="button" className={SECONDARY_BUTTON_CLASS} onClick={() => setConfirming(false)}>
            Never mind
          </button>
        </div>
      ) : (
        <button type="button" className={SECONDARY_BUTTON_CLASS} onClick={() => setConfirming(true)}>
          No-show
        </button>
      )}
      {error !== null && (
        <p role="alert" className="text-xs text-destructive-700">
          {error}
        </p>
      )}
    </div>
  );
}
