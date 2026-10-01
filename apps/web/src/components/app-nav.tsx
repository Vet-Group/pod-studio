'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ScreenIcon } from '@/components/screen-icon';
import { cn } from '@/lib/utils';
import { screens } from '@/lib/screens';

/**
 * Sidebar list above 760px; at 760px and below a 4-column grid at the top of the page with the
 * full labels wrapping, exactly like `.nav` in design/wireframes/index.html.
 */
export function AppNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main navigation">
      <ul className="grid gap-1.5 max-md:grid-cols-4 max-md:gap-1 max-md:pb-2.5">
        {screens.map((s) => {
          const href = `/${s.slug}` as const;
          const current = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <li key={s.slug} className="flex max-md:min-w-0">
              <Link
                href={href}
                data-tap
                aria-current={current ? 'page' : undefined}
                className={cn(
                  'text-ink hover:bg-soft flex flex-1 items-center gap-3 rounded-[7px] p-3 text-[13px] font-medium whitespace-nowrap',
                  'max-md:min-h-[52px] max-md:flex-col max-md:justify-start max-md:gap-1 max-md:px-[3px] max-md:pt-[9px] max-md:pb-1.5 max-md:text-center max-md:text-[11.5px] max-md:leading-[1.25] max-md:whitespace-normal',
                  current && 'bg-selected text-teal hover:bg-selected font-bold',
                )}
              >
                <ScreenIcon slug={s.slug} className="size-[18px] shrink-0 max-md:size-4" />
                <span className="max-md:text-balance max-md:[overflow-wrap:anywhere]">{s.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
