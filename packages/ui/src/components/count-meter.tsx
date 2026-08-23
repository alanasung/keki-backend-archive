import { cn } from '../cn';

// Presentational only — arrived/expected are plain numbers, not reservation
// or check-in state, so /staff/today and the occupancy surface (WS-06,
// WS-08) can both render a fill against a headcount without this component
// knowing what either surface means by "expected".
export interface CountMeterProps {
  readonly arrived: number;
  readonly expected: number;
  readonly className?: string;
}

export function CountMeter({ arrived, expected, className }: CountMeterProps) {
  // A class with no bookings is ordinary, especially early in the day — an
  // empty meter, not a division by zero, is the correct rendering.
  const fraction = expected > 0 ? Math.min(1, arrived / expected) : 0;

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-200">
        <div className="h-full rounded-full bg-brand-500" style={{ width: `${fraction * 100}%` }} />
      </div>
      <span className="text-sm text-surface-700">
        <span>{arrived}</span>
        <span className="text-surface-400"> / </span>
        <span>{expected}</span>
      </span>
    </div>
  );
}
