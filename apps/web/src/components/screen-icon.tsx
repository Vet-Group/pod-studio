import type { ScreenSlug } from '@/lib/screens';

/** Stroke icons copied from `icons` in design/wireframes/index.html, keyed by screen. */
const paths: Record<ScreenSlug, React.ReactNode> = {
  'thiet-ke': (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),
  duyet: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="3" />
      <path d="m8 12 3 3 6-6" />
    </>
  ),
  'noi-dung': <path d="M5 3h10l4 4v14H5zM9 11h6M9 15h6M9 7h3" />,
  'san-pham': <path d="m3 7 9-4 9 4-9 4zM3 7v11l9 4 9-4V7M12 11v11" />,
  'cua-hang': <path d="M3 10h18M4 10v11h16V10M2 10l3-7h14l3 7M9 21v-7h6v7" />,
  'ky-nang': <path d="m12 2 2 7 7 3-7 2-2 8-2-8-8-2 8-3z" />,
  ngach: (
    <>
      <path d="M4 5h16M4 12h10M4 19h7" />
      <circle cx="18" cy="17" r="3" />
    </>
  ),
};

export function ScreenIcon({ slug, className }: { slug: ScreenSlug; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.4} aria-hidden="true" className={className}>
      {paths[slug]}
    </svg>
  );
}
