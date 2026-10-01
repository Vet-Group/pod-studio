'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Native modal `<dialog>` styled like `dialog` in design/wireframes/index.html. The browser provides
 * the focus trap, Escape to close and the inert background.
 */
export function Modal({
  open,
  onClose,
  labelledBy,
  children,
}: {
  open: boolean;
  onClose: () => void;
  labelledBy: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={labelledBy}
      onClose={onClose}
      className="bg-paper text-ink border-line m-auto max-h-[calc(100dvh-30px)] w-[min(580px,calc(100%-30px))] overflow-auto rounded-[14px] border p-7 shadow-[0_25px_80px_rgba(36,44,42,0.22)] backdrop:bg-[rgba(36,44,42,0.42)] max-md:p-5"
    >
      {children}
    </dialog>
  );
}

/** Label + select, same geometry as `label select` in the wireframe. */
export function SelectField({
  label,
  value,
  onChange,
  children,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className="block text-[13px] font-semibold">
      {label}
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.currentTarget.value)}
        className="border-line bg-paper text-ink mt-[7px] block w-full rounded-[7px] border px-3 py-2.5 font-normal"
      >
        {children}
      </select>
    </label>
  );
}
