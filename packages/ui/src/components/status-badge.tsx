import { cn } from '../cn';

// A generic pill, deliberately ignorant of what a status means — the
// offerings surface (WS-06) is the first caller, but staff and reservation
// surfaces reuse it with their own vocabularies, so it takes a label and a
// tone rather than a domain status.
export type StatusBadgeTone = 'neutral' | 'accent' | 'muted';

export interface StatusBadgeProps {
  readonly label: string;
  readonly tone: StatusBadgeTone;
  readonly className?: string;
}

const TONE_CLASSES: Readonly<Record<StatusBadgeTone, string>> = {
  neutral: 'bg-surface-200 text-surface-800',
  accent: 'bg-brand-100 text-brand-700',
  muted: 'bg-surface-100 text-surface-500',
};

export function StatusBadge({ label, tone, className }: StatusBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
        TONE_CLASSES[tone],
        className,
      )}
    >
      {label}
    </span>
  );
}
