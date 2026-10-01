import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { HOME_SCREEN } from '@/lib/screens';

export default function NotFound() {
  return (
    <section className="flex flex-col items-start gap-4">
      <h1 className="text-[30px] leading-[1.2] font-semibold tracking-[-1px] max-md:text-[27px]">Page not found</h1>
      <p className="text-muted">This address does not exist in POD Studio.</p>
      <Button asChild variant="primary">
        <Link href={`/${HOME_SCREEN.slug}`}>Back to {HOME_SCREEN.label}</Link>
      </Button>
    </section>
  );
}
