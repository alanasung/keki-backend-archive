'use client';

import { useState, useTransition } from 'react';
import { payMockOrderAction } from './pay-action';

/**
 * Decorative card fields for the mock checkout.
 *
 * The values are never read, never submitted, and never leave the browser —
 * only `orderId` is sent to the server action. They exist so the demo looks
 * like a checkout; they are not a payment form, and the banner on the page
 * says so.
 */
export function PaymentForm({ orderId, totalLabel }: { orderId: string; totalLabel: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Local state only. Deliberately never included in the action payload.
  const [card, setCard] = useState('4111 1111 1111 1111');
  const [expiry, setExpiry] = useState('12 / 28');
  const [cvc, setCvc] = useState('123');

  function submit(): void {
    setError(null);
    startTransition(async () => {
      const result = await payMockOrderAction({ orderId });
      if (result.ok) {
        window.location.href = `/orders/${orderId}`;
        return;
      }
      setError(result.error.message);
    });
  }

  const field =
    'w-full rounded-md border border-surface-200 bg-white px-3 py-2 text-sm text-surface-900 ' +
    'placeholder:text-surface-400 focus:border-brand-500 focus:outline-none';

  return (
    <div className="flex flex-col gap-4">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-semibold uppercase tracking-wide text-surface-600">Card number</span>
        <input className={field} value={card} onChange={(e) => setCard(e.target.value)} inputMode="numeric" />
      </label>

      <div className="grid grid-cols-2 gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-surface-600">Expiry</span>
          <input className={field} value={expiry} onChange={(e) => setExpiry(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-surface-600">CVC</span>
          <input className={field} value={cvc} onChange={(e) => setCvc(e.target.value)} inputMode="numeric" />
        </label>
      </div>

      {error !== null && (
        <p className="rounded-md bg-destructive-50 px-3 py-2 text-sm text-destructive-700">{error}</p>
      )}

      <button
        type="button"
        onClick={submit}
        disabled={pending}
        className="rounded-lg bg-brand-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-60"
      >
        {pending ? 'Processing…' : `Pay ${totalLabel}`}
      </button>
    </div>
  );
}
