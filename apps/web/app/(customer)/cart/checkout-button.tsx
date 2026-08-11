'use client';

import { useState, useTransition } from 'react';
import { checkoutAction } from './checkout-action';

export interface CheckoutButtonProps {
  readonly disabled?: boolean;
}

export function CheckoutButton({ disabled = false }: CheckoutButtonProps) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleClick(): void {
    setError(null);
    startTransition(async () => {
      const result = await checkoutAction({});
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      // A double-click's first defense: disabling while pending. The real
      // one is WS-05's idempotent startCheckout, because a determined
      // double-click still gets through this.
      window.location.assign(result.data.checkoutUrl);
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled || isPending}
        className="rounded bg-surface-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {isPending ? 'Starting checkout…' : 'Checkout'}
      </button>
      {error !== null && (
        <p role="alert" className="text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
