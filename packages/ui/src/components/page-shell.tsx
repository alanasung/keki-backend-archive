import type { ReactNode } from 'react';
import { cn } from '../cn';

export interface PageShellProps {
  readonly title: string;
  readonly description?: string;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}

export function PageShell({ title, description, actions, children, className }: PageShellProps) {
  return (
    <div className={cn('flex flex-col gap-6', className)}>
      <header className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold text-surface-900">{title}</h1>
          {description !== undefined && <p className="text-sm text-surface-600">{description}</p>}
        </div>
        {actions !== undefined && <div className="flex items-center gap-2">{actions}</div>}
      </header>
      <main>{children}</main>
    </div>
  );
}
