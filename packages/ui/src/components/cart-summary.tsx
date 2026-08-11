import type { ReactNode } from 'react';
import { cn } from '../cn';
import { EmptyState } from './empty-state';
import { Price } from './price';

export interface CartSummaryLine {
  readonly id: string;
  readonly name: string;
  readonly quantity: number;
  // Both prices are resolved server-side from the catalog, never carried in
  // from the cart cookie — see apps/web's resolve-cart.ts.
  readonly unitPriceCents: number;
  readonly currency: string;
  readonly lineTotalCents: number;
  readonly participantNames?: readonly string[];
  readonly available: boolean;
  readonly unavailableReason?: string;
  // Reserved for WS-09's per-line remove control, mirroring
  // CatalogItemCard's footer slot: this component stays purely
  // presentational, with no Server Action import of its own.
  readonly action?: ReactNode;
}

export interface CartSummaryProps {
  readonly lines: readonly CartSummaryLine[];
  readonly subtotalCents: number;
  readonly currency: string;
  readonly className?: string;
}

export function CartSummary({ lines, subtotalCents, currency, className }: CartSummaryProps) {
  if (lines.length === 0) {
    return (
      <EmptyState
        title="Your cart is empty"
        description="Add cafe items or book a class to get started."
        {...(className !== undefined ? { className } : {})}
      />
    );
  }

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      <ul className="flex flex-col gap-3">
        {lines.map((line) => (
          <li
            key={line.id}
            className={cn(
              'flex flex-col gap-1 rounded-lg border p-4',
              line.available ? 'border-surface-200 bg-white' : 'border-amber-300 bg-amber-50',
            )}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex flex-col gap-1">
                <p className="text-sm font-semibold text-surface-900">{line.name}</p>
                <p className="text-xs text-surface-600">Qty {line.quantity}</p>
                {line.participantNames !== undefined && line.participantNames.length > 0 && (
                  <p className="text-xs text-surface-600">For: {line.participantNames.join(', ')}</p>
                )}
                {!line.available && (
                  <p className="text-xs font-medium text-amber-700">
                    {line.unavailableReason ?? 'This item is no longer available.'}
                  </p>
                )}
              </div>
              <div className="flex flex-shrink-0 flex-col items-end gap-2">
                {line.available && <Price cents={line.lineTotalCents} currency={line.currency} />}
                {line.action}
              </div>
            </div>
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-1 border-t border-surface-200 pt-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-surface-900">Subtotal</span>
          <Price cents={subtotalCents} currency={currency} />
        </div>
        {/* Square computes the authoritative total, tax included, at
            checkout (WS-13) — this subtotal must never read as the final
            charge. */}
        <p className="text-xs text-surface-500">Tax is calculated at checkout.</p>
      </div>
    </div>
  );
}
