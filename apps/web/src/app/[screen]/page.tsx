import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { findScreen, screens } from '@/lib/screens';

export const dynamicParams = false;

export function generateStaticParams() {
  return screens.map((s) => ({ screen: s.slug }));
}

export async function generateMetadata({ params }: PageProps<'/[screen]'>): Promise<Metadata> {
  const screen = findScreen((await params).screen);
  return { title: screen?.label ?? 'Không tìm thấy' };
}

export default async function ScreenPlaceholder({ params }: PageProps<'/[screen]'>) {
  const screen = findScreen((await params).screen);
  if (!screen) notFound();

  return (
    <section aria-labelledby="screen-title">
      {/* Same type scale as `.pagehead` / `.eyebrow` / `h1` in the wireframe. */}
      <header className="mb-[25px] max-md:mb-5">
        <p className="text-muted mb-[9px] text-[11.5px] font-bold tracking-[1.2px] uppercase">Khung dev · {screen.task}</p>
        <h1 id="screen-title" className="text-[30px] leading-[1.2] font-semibold tracking-[-1px] max-md:text-[27px]">
          {screen.label}
        </h1>
        <p className="text-muted mt-2.5 max-w-[60ch] text-[13px] text-pretty">
          Màn này chưa được dựng. Nó sẽ được làm trong task <strong className="text-ink">{screen.task}</strong> theo
          wireframe đã chốt.
        </p>
      </header>
      <div className="border-line bg-paper rounded-card border p-[22px] max-md:p-[18px]">
        <h2 className="text-[15px] font-bold">Trạng thái môi trường dev</h2>
        <ul className="text-muted mt-3 list-disc space-y-1 pl-5">
          <li>Next.js App Router, React 19, TypeScript strict và Tailwind CSS v4 đang chạy.</li>
          <li>Điều hướng, bố cục responsive và màu sắc lấy từ wireframe.</li>
          <li>Chưa có dữ liệu thật, đăng nhập hay kết nối cơ sở dữ liệu (P1-02, P1-03).</li>
        </ul>
      </div>
    </section>
  );
}
