'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';

// This is the whole freshness story for the page — no polling, no
// streaming. A staff member who wants a newer number presses this.
// Awaiting the refresh keeps `isPending` true for the duration of the
// in-flight navigation, so a rapid double-press disables rather than
// queues a second one.
export function RefreshButton() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function handleRefresh(): void {
    startTransition(async () => {
      await Promise.resolve(router.refresh());
    });
  }

  return (
    <button
      type="button"
      onClick={handleRefresh}
      disabled={isPending}
      className="rounded-md border border-surface-300 px-3 py-1.5 text-sm font-medium text-surface-800 transition hover:bg-surface-100 disabled:opacity-50"
    >
      {isPending ? 'Refreshing…' : 'Refresh'}
    </button>
  );
}
