import type { ReactNode } from 'react';
import { cn } from '../cn';
import { Price } from './price';

export interface CatalogItemCardProps {
  readonly name: string;
  readonly description?: string | null;
  readonly priceCents: number;
  readonly currency: string;
  // Reserved for WS-09's cart/add action. This component stays purely
  // presentational — no data fetching, no Server Action imports — so WS-09
  // can slot a button in here without touching this file.
  readonly footer?: ReactNode;
  readonly className?: string;
}

export function CatalogItemCard({ name, description, priceCents, currency, footer, className }: CatalogItemCardProps) {
  return (
    <article className={cn('flex flex-col gap-2 rounded-lg border border-surface-200 bg-white p-4', className)}>
      <div className="flex items-start justify-between gap-4">
        <h4 className="text-sm font-semibold text-surface-900">{name}</h4>
        <Price cents={priceCents} currency={currency} />
      </div>
      {description !== null && description !== undefined && description !== '' && (
        <p className="text-sm text-surface-600">{description}</p>
      )}
      {footer !== undefined && <div className="pt-2">{footer}</div>}
    </article>
  );
}
