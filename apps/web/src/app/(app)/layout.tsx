import { AppNav } from '@/components/app-nav';
import { AccountMenu } from '@/components/auth/account-menu';
import { requireAppSession } from '@/lib/session';

/**
 * Signed-in workspace: sidebar navigation plus the current account. Every page in this group needs a
 * session with a permanent password; proxy.ts redirects first, this check holds if it is skipped.
 */
export default async function AppLayout({ children }: LayoutProps<'/'>) {
  const session = await requireAppSession('/');
  const { name, email, role } = session.user;

  return (
    <>
      <a
        href="#main"
        className="focus:bg-paper sr-only focus:not-sr-only focus:fixed focus:top-2.5 focus:left-[230px] focus:z-50 focus:inline-flex focus:min-h-11 focus:items-center focus:p-2.5 max-md:focus:left-4"
      >
        Skip to main content
      </a>
      <div className="min-h-dvh md:pl-[216px]">
        {/* Geometry mirrors `.sidebar`, `.brand`, `.navlabel` and `.sidebottom` in the wireframe. */}
        <aside className="border-line bg-sidebar z-20 flex flex-col border-r px-4 py-7 md:fixed md:inset-y-0 md:left-0 md:w-[216px] max-md:border-r-0 max-md:border-b max-md:px-4 max-md:pt-3.5 max-md:pb-0">
          <div className="flex items-center gap-2.5 px-3 pb-[31px] text-[20px] tracking-[-0.8px] max-md:px-0 max-md:pb-3.5 max-md:text-[18px]">
            <span
              aria-hidden="true"
              className="bg-teal grid size-[30px] place-items-center rounded-[9px] font-serif text-[25px] tracking-normal text-white italic max-md:size-[27px]"
            >
              p
            </span>
            <strong>
              pod studio<span className="text-teal">.</span>
            </strong>
          </div>
          <div className="text-muted px-3 pb-3 text-[11.5px] font-bold tracking-[1.2px] uppercase max-md:hidden">Workspace</div>
          <AppNav />
          <AccountMenu name={name} email={email} role={role === 'admin' ? 'Admin' : 'Member'} />
        </aside>
        <main
          id="main"
          tabIndex={-1}
          className="mx-auto w-full max-w-[1680px] px-9 pt-8 pb-[50px] max-lg:px-6 max-lg:py-[26px] max-md:px-[18px] max-md:pt-6 max-md:pb-10"
        >
          {children}
        </main>
      </div>
    </>
  );
}
