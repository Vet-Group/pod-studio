import { cn } from '@/lib/utils';

export function initials(name: string): string {
  const letters = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase());
  return letters.join('') || '?';
}

/** `.avatar` from the wireframe: 32px circle with initials. */
export function Avatar({ label, className }: { label: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-grid size-8 shrink-0 place-items-center rounded-full bg-[#dcc8b6] text-[12.5px] font-bold text-[#5a4a3a]',
        className,
      )}
    >
      {label}
    </span>
  );
}
