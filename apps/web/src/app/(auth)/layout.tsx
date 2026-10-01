/**
 * Sign-in, invite and change-password pages: no navigation, one narrow column. The column is the
 * same on every screen size, so desktop work here needs no separate phone layout.
 */
export default function AuthLayout({ children }: LayoutProps<'/'>) {
  return (
    <div className="flex min-h-dvh flex-col items-center px-[18px] pt-[12vh] pb-12 max-md:pt-10">
      <div className="w-full max-w-[400px]">
        <div className="mb-9 flex items-center gap-2.5 text-[20px] tracking-[-0.8px]">
          <span
            aria-hidden="true"
            className="bg-teal grid size-[30px] place-items-center rounded-[9px] font-serif text-[25px] tracking-normal text-white italic"
          >
            p
          </span>
          <strong>
            pod studio<span className="text-teal">.</span>
          </strong>
        </div>
        <main id="main">{children}</main>
      </div>
    </div>
  );
}
