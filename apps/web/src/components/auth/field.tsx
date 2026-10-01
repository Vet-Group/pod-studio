'use client';

import { useId, type ComponentProps } from 'react';
import { cn } from '@/lib/utils';

interface FieldProps extends Omit<ComponentProps<'input'>, 'id'> {
  label: string;
  /** Help text under the input, read out with it. */
  hint?: string;
  /** Message for this field; marks the input invalid. */
  error?: string;
}

/** Label, input, hint and error stacked like `label input` in the wireframe (13px label, 7px gap). */
export function Field({ label, hint, error, className, ...input }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className={className}>
      <label htmlFor={id} className="block text-[13px] font-semibold">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined}
        className={cn(
          'bg-paper text-ink border-line mt-[7px] block h-11 w-full min-w-0 rounded-[7px] border px-3 text-[14px]',
          'placeholder:text-muted/70 read-only:bg-sidebar read-only:text-muted',
          error && 'border-orange',
        )}
        {...input}
      />
      {hint && (
        <p id={hintId} className="text-muted mt-1.5 text-[12.5px]">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-orange mt-1.5 text-[12.5px] font-semibold">
          {error}
        </p>
      )}
    </div>
  );
}

/** Form-level error, announced when it appears. */
export function FormAlert({ message }: { message: string | null }) {
  return (
    <div role="alert" aria-live="assertive" className="empty:hidden">
      {message && (
        <p className="border-orange/40 text-orange rounded-lg border bg-[#fbefe8] px-4 py-3 text-[13px] font-semibold">
          {message}
        </p>
      )}
    </div>
  );
}
