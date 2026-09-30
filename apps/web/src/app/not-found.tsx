import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <section className="flex flex-col items-start gap-4">
      <h1 className="text-[30px] leading-[1.2] font-semibold tracking-[-1px] max-md:text-[27px]">Không tìm thấy trang</h1>
      <p className="text-muted">Đường dẫn này không tồn tại trong POD Studio.</p>
      <Button asChild variant="primary">
        <Link href="/thiet-ke">Về Thư viện thiết kế</Link>
      </Button>
    </section>
  );
}
