'use client';

import { useState, useTransition } from 'react';
import type { Offering } from '@keki/contracts';
import type { ActionResult } from '../../actions/action-result';
import {
  archiveOfferingAction,
  publishOfferingAction,
  unpublishOfferingAction,
} from '../actions/offering-actions';
import { OfferingForm } from './offering-form';

export interface OfferingRowProps {
  readonly offering: Offering;
}

const SECONDARY_BUTTON_CLASS =
  'rounded-md border border-surface-300 px-3 py-1.5 text-xs font-medium text-surface-800 ' +
  'transition hover:bg-surface-100 disabled:opacity-50';
const PRIMARY_BUTTON_CLASS =
  'rounded-md bg-brand-500 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50';
const DANGER_BUTTON_CLASS =
  'rounded-md bg-destructive-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-destructive-700 disabled:opacity-50';

// Mirrors OFFERING_TRANSITIONS in @keki/contracts (packages/contracts/src/admin.ts):
// DRAFT -> [Publish, Archive], PUBLISHED -> [Unpublish, Archive], ARCHIVED -> [].
// This table is a convenience, not the guard — WS-05's actions enforce the
// real one — but offering a control the server will refuse is a worse
// experience than not offering it.
export function OfferingRow({ offering }: OfferingRowProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function runTransition(action: (raw: unknown) => Promise<ActionResult<Offering>>): void {
    setError(null);
    startTransition(async () => {
      // The client never sends a target status — each action fixes its own.
      const result = await action({ offeringId: offering.id });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setConfirmingArchive(false);
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={SECONDARY_BUTTON_CLASS} onClick={() => setIsEditing((current) => !current)}>
          {isEditing ? 'Cancel' : 'Edit'}
        </button>

        {offering.status === 'DRAFT' && (
          <>
            <button
              type="button"
              className={PRIMARY_BUTTON_CLASS}
              disabled={isPending}
              onClick={() => runTransition(publishOfferingAction)}
            >
              Publish
            </button>
            <span className="text-xs text-surface-500">
              Publishing makes this class visible on the customer booking page.
            </span>
          </>
        )}

        {offering.status === 'PUBLISHED' && (
          <button
            type="button"
            className={SECONDARY_BUTTON_CLASS}
            disabled={isPending}
            onClick={() => runTransition(unpublishOfferingAction)}
          >
            Unpublish
          </button>
        )}

        {offering.status !== 'ARCHIVED' &&
          (confirmingArchive ? (
            <span className="flex items-center gap-2">
              <span className="text-xs text-surface-600">Archive this offering? This cannot be undone.</span>
              <button
                type="button"
                className={DANGER_BUTTON_CLASS}
                disabled={isPending}
                onClick={() => runTransition(archiveOfferingAction)}
              >
                Confirm archive
              </button>
              <button type="button" className={SECONDARY_BUTTON_CLASS} onClick={() => setConfirmingArchive(false)}>
                Cancel
              </button>
            </span>
          ) : (
            <button type="button" className={SECONDARY_BUTTON_CLASS} onClick={() => setConfirmingArchive(true)}>
              Archive
            </button>
          ))}
      </div>

      {error !== null && (
        <p role="alert" className="text-xs text-destructive-700">
          {error}
        </p>
      )}

      {isEditing && (
        <div className="rounded-md border border-surface-200 bg-surface-50 p-3">
          <OfferingForm offering={offering} onSuccess={() => setIsEditing(false)} />
        </div>
      )}
    </div>
  );
}
