import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { BUILT_SCREENS, findScreen, screens } from '@/lib/screens';

export const dynamicParams = false;

export function generateStaticParams() {
  return screens.filter((s) => !BUILT_SCREENS.has(s.slug)).map((s) => ({ screen: s.slug }));
}

export async function generateMetadata({ params }: PageProps<'/[screen]'>): Promise<Metadata> {
  const screen = findScreen((await params).screen);
  return { title: screen?.label ?? 'Not found' };
}

export default async function ScreenPlaceholder({ params }: PageProps<'/[screen]'>) {
  const screen = findScreen((await params).screen);
  if (!screen || BUILT_SCREENS.has(screen.slug)) notFound();

  return (
    <section aria-labelledby="screen-title">
      {/* Same type scale as `.pagehead` / `.eyebrow` / `h1` in the wireframe. */}
      <header className="mb-[25px] max-md:mb-5">
        <p className="text-muted mb-[9px] text-[11.5px] font-bold tracking-[1.2px] uppercase">Dev shell · {screen.task}</p>
        <h1 id="screen-title" className="text-[30px] leading-[1.2] font-semibold tracking-[-1px] max-md:text-[27px]">
          {screen.label}
        </h1>
        <p className="text-muted mt-2.5 max-w-[60ch] text-[13px] text-pretty">
          This screen is not built yet. Task <strong className="text-ink">{screen.task}</strong> builds it from the
          approved wireframe.
        </p>
      </header>
      <div className="border-line bg-paper rounded-card border p-[22px] max-md:p-[18px]">
        <h2 className="text-[15px] font-bold">Dev environment status</h2>
        <ul className="text-muted mt-3 list-disc space-y-1 pl-5">
          <li>Next.js App Router, React 19, strict TypeScript and Tailwind CSS v4 are running.</li>
          <li>Navigation, responsive layout and colors come from the wireframe.</li>
          <li>Sign-in, invite links and temporary passwords work (P1-03); no store data yet (P1-04).</li>
        </ul>
      </div>
    </section>
  );
}
