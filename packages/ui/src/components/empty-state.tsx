import { cn } from '../cn';

export interface EmptyStateProps {
  readonly title: string;
  readonly description?: string;
  readonly className?: string;
}

export function EmptyState({ title, description, className }: EmptyStateProps) {
  return (
    <div
      role="status"
      className={cn(
        'flex flex-col gap-2 rounded-lg border border-dashed border-surface-300 bg-surface-50 p-6',
        className,
      )}
    >
      <p className="text-sm font-semibold text-surface-700">{title}</p>
      {description !== undefined && <p className="text-sm text-surface-500">{description}</p>}
    </div>
  );
}
