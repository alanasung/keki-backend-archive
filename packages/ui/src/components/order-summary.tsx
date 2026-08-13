import { cn } from '../cn';
import { Price } from './price';

// Plain string union rather than an @keki/contracts import: this package
// depends on no domain package (see cart-summary.tsx's own CartSummaryLine
// for the same choice), so the caller maps its branded OrderStatus down to
// this shape.
export type OrderSummaryStatus = 'DRAFT' | 'AWAITING_PAYMENT' | 'PAID' | 'CANCELLED' | 'EXPIRED';

export interface OrderSummaryLine {
  readonly id: string;
  readonly name: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
  readonly currency: string;
  readonly lineTotalCents: number;
  readonly participantNames?: readonly string[];
}

export interface OrderSummaryProps {
  readonly status: OrderSummaryStatus;
  readonly lines: readonly OrderSummaryLine[];
  readonly subtotalCents: number;
  readonly currency: string;
  readonly className?: string;
}

const STATUS_LABELS: Record<OrderSummaryStatus, string> = {
  DRAFT: 'Checkout not completed',
  AWAITING_PAYMENT: 'Payment processing',
  PAID: 'Paid',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
};

// Presentational only: no data fetching, no Server Action import. The
// caller (apps/web's order status page) decides what surrounding
// explanation and links accompany each status — this component only
// renders what was purchased and its current state.
export function OrderSummary({ status, lines, subtotalCents, currency, className }: OrderSummaryProps) {
  return (
    <div className={cn('flex flex-col gap-4', className)}>
      <p className="text-sm font-semibold text-surface-900">{STATUS_LABELS[status]}</p>
      <ul className="flex flex-col gap-3">
        {lines.map((line) => (
          <li key={line.id} className="flex flex-col gap-1 rounded-lg border border-surface-200 bg-white p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex flex-col gap-1">
                <p className="text-sm font-semibold text-surface-900">{line.name}</p>
                <p className="text-xs text-surface-600">Qty {line.quantity}</p>
                {line.participantNames !== undefined && line.participantNames.length > 0 && (
                  <p className="text-xs text-surface-600">For: {line.participantNames.join(', ')}</p>
                )}
              </div>
              <Price cents={line.lineTotalCents} currency={line.currency} />
            </div>
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between border-t border-surface-200 pt-4">
        <span className="text-sm font-semibold text-surface-900">Subtotal</span>
        <Price cents={subtotalCents} currency={currency} />
      </div>
    </div>
  );
}
