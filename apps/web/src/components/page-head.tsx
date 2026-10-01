import type { ReactNode } from 'react';

/** `.pagehead` from the wireframe: eyebrow, title and subtitle on the left, actions on the right. */
export function PageHead({
  eyebrow,
  title,
  children,
  actions,
}: {
  eyebrow: ReactNode;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-[25px] flex items-start justify-between gap-5 max-md:mb-5 max-md:flex-col max-md:gap-[17px]">
      <div className="min-w-0">
        <p className="text-muted mb-[9px] text-[11.5px] font-bold tracking-[1.2px] uppercase">{eyebrow}</p>
        <h1
          id="screen-title"
          className="text-[30px] leading-[1.2] font-semibold tracking-[-1px] text-balance [overflow-wrap:anywhere] max-md:text-[27px]"
        >
          {title}
        </h1>
        {children && <p className="text-muted mt-2.5 max-w-[60ch] text-[13px] text-pretty">{children}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2 max-md:w-full">{actions}</div>}
    </header>
  );
}
