import { cn } from '../cn';

export interface PlaceholderPanelProps {
  readonly title: string;
  readonly plannedFor?: string;
  readonly className?: string;
}

export function PlaceholderPanel({ title, plannedFor, className }: PlaceholderPanelProps) {
  return (
    <div
      role="status"
      className={cn(
        'flex flex-col gap-2 rounded-lg border border-dashed border-surface-300 bg-surface-50 p-6',
        className,
      )}
    >
      <p className="text-sm font-semibold text-surface-700">{title}</p>
      <p className="text-sm text-surface-500">
        This surface is not built yet.{plannedFor !== undefined ? ` Planned for ${plannedFor}.` : ''}
      </p>
    </div>
  );
}
