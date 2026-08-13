'use client';

import { useState, useTransition } from 'react';
import type { CatalogItemId, OccurrenceId } from '@keki/contracts';
import { removeLineAction } from './actions';

export type RemoveLineButtonProps =
  | { readonly kind: 'CATALOG_ITEM'; readonly catalogItemId: CatalogItemId }
  | { readonly kind: 'OCCURRENCE'; readonly occurrenceId: OccurrenceId };

export function RemoveLineButton(props: RemoveLineButtonProps) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleClick(): void {
    setError(null);
    startTransition(async () => {
      const result = await removeLineAction(
        props.kind === 'CATALOG_ITEM'
          ? { kind: 'CATALOG_ITEM', catalogItemId: props.catalogItemId }
          : { kind: 'OCCURRENCE', occurrenceId: props.occurrenceId },
      );
      if (!result.ok) {
        setError(result.error.message);
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={handleClick}
        disabled={isPending}
        className="text-xs font-medium text-red-600 underline disabled:opacity-50"
      >
        {isPending ? 'Removing…' : 'Remove'}
      </button>
      {error !== null && (
        <p role="alert" className="text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
