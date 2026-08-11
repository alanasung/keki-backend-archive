'use client';

import { useState, useTransition } from 'react';
import type { CatalogItemId } from '@keki/contracts';
import { addCafeItemAction } from '../cart/actions';

export interface AddToCartButtonProps {
  readonly catalogItemId: CatalogItemId;
}

const MIN_QUANTITY = 1;
const MAX_QUANTITY = 99;

export function AddToCartButton({ catalogItemId }: AddToCartButtonProps) {
  const [quantity, setQuantity] = useState(MIN_QUANTITY);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState(false);

  function handleSubmit(): void {
    setError(null);
    setAdded(false);
    startTransition(async () => {
      const result = await addCafeItemAction({ catalogItemId, quantity });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setAdded(true);
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Decrease quantity"
            onClick={() => setQuantity((current) => Math.max(MIN_QUANTITY, current - 1))}
            disabled={isPending || quantity <= MIN_QUANTITY}
            className="h-6 w-6 rounded border border-surface-300 text-sm disabled:opacity-50"
          >
            −
          </button>
          <span aria-live="polite" className="w-6 text-center text-sm">
            {quantity}
          </span>
          <button
            type="button"
            aria-label="Increase quantity"
            onClick={() => setQuantity((current) => Math.min(MAX_QUANTITY, current + 1))}
            disabled={isPending || quantity >= MAX_QUANTITY}
            className="h-6 w-6 rounded border border-surface-300 text-sm disabled:opacity-50"
          >
            +
          </button>
        </div>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={isPending}
          className="rounded bg-surface-900 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
        >
          {isPending ? 'Adding…' : 'Add to cart'}
        </button>
      </div>
      {error !== null && (
        <p role="alert" className="text-xs text-red-600">
          {error}
        </p>
      )}
      {added && (
        <p role="status" className="text-xs text-emerald-700">
          Added to cart.
        </p>
      )}
    </div>
  );
}
