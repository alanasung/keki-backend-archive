import type { ReactNode } from 'react';
import { cn } from '../cn';

export interface FormFieldProps {
  readonly label: string;
  readonly htmlFor: string;
  readonly children: ReactNode;
  readonly hint?: string;
  readonly error?: string;
  readonly className?: string;
}

// The admin forms (WS-06) are the first forms in the codebase; every later
// staff form reuses this rather than re-inventing label/hint/error markup.
// The control itself is a slot, not rendered here, so any input, select, or
// textarea can be the labelled element.
export function FormField({ label, htmlFor, children, hint, error, className }: FormFieldProps) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label htmlFor={htmlFor} className="text-sm font-medium text-surface-800">
        {label}
      </label>
      {children}
      {error !== undefined ? (
        <p role="alert" className="text-xs text-destructive-600">
          {error}
        </p>
      ) : (
        hint !== undefined && <p className="text-xs text-surface-500">{hint}</p>
      )}
    </div>
  );
}
