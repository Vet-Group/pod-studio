import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { HOME_SCREEN } from '@/lib/screens';

/** Rendered by the root layout, outside the signed-in sidebar, so it stands on its own. */
export default function NotFound() {
  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-[400px] flex-col items-start justify-center gap-4 px-[18px]">
      <h1 className="text-[30px] leading-[1.2] font-semibold tracking-[-1px] max-md:text-[27px]">Page not found</h1>
      <p className="text-muted">This address does not exist in POD Studio.</p>
      <Button asChild variant="primary" className="h-11">
        <Link href={`/${HOME_SCREEN.slug}`}>Back to {HOME_SCREEN.label}</Link>
      </Button>
    </main>
  );
}
