import { cn } from '../cn';

export interface ParticipantChecklistOption {
  readonly id: string;
  readonly displayName: string;
}

export interface ParticipantChecklistProps {
  readonly options: readonly ParticipantChecklistOption[];
  readonly selectedIds: readonly string[];
  readonly onToggle: (id: string) => void;
  // Omitted (rather than 0) means "no cap" — a picker with no known
  // capacity yet should not disable every option.
  readonly maxSelectable?: number;
  readonly className?: string;
}

// Purely presentational and controlled: seat count is always
// `selectedIds.length`, rendered here rather than accepted as a prop, so
// there is exactly one place that number can be computed wrong. No number
// input exists anywhere in this component — two sources for seat count
// would eventually disagree (see @keki/contracts's CartLine).
export function ParticipantChecklist({
  options,
  selectedIds,
  onToggle,
  maxSelectable,
  className,
}: ParticipantChecklistProps) {
  const selectedSet = new Set(selectedIds);
  const atCapacity = maxSelectable !== undefined && selectedSet.size >= maxSelectable;

  return (
    <fieldset className={cn('flex flex-col gap-2', className)}>
      <legend className="text-xs font-medium text-surface-600">
        {selectedSet.size} seat{selectedSet.size === 1 ? '' : 's'} selected
      </legend>
      {options.map((option) => {
        const checked = selectedSet.has(option.id);
        return (
          <label key={option.id} className="flex items-center gap-2 text-sm text-surface-800">
            <input
              type="checkbox"
              checked={checked}
              disabled={!checked && atCapacity}
              onChange={() => onToggle(option.id)}
            />
            {option.displayName}
          </label>
        );
      })}
    </fieldset>
  );
}
