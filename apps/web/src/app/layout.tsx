import type { Metadata, Viewport } from 'next';
import { AppNav } from '@/components/app-nav';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'POD Studio', template: '%s · POD Studio' },
  description: 'Xưởng thiết kế và đăng sản phẩm print-on-demand.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#f7f6f2',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi">
      <body>
        <a
          href="#main"
          className="focus:bg-paper sr-only focus:not-sr-only focus:fixed focus:top-2.5 focus:left-[230px] focus:z-50 focus:inline-flex focus:min-h-11 focus:items-center focus:p-2.5 max-md:focus:left-4"
        >
          Đến nội dung chính
        </a>
        <div className="min-h-dvh md:pl-[216px]">
          {/* Geometry mirrors `.sidebar`, `.brand` and `.navlabel` in the wireframe. */}
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
            <div className="text-muted px-3 pb-3 text-[11.5px] font-bold tracking-[1.2px] uppercase max-md:hidden">Bàn làm việc</div>
            <AppNav />
          </aside>
          <main
            id="main"
            tabIndex={-1}
            className="mx-auto w-full max-w-[1680px] px-9 pt-8 pb-[50px] max-lg:px-6 max-lg:py-[26px] max-md:px-[18px] max-md:pt-6 max-md:pb-10"
          >
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
