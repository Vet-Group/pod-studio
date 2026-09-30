/**
 * Primary navigation. Labels, order and icons match `navs`/`icons` in design/wireframes/index.html.
 * `task` is the tasks/tasks.json entry that builds the real screen; until then the route renders a
 * placeholder.
 */
export const screens = [
  { slug: 'thiet-ke', label: 'Thư viện thiết kế', task: 'P1-09', wireframe: 'studio' },
  { slug: 'duyet', label: 'Duyệt thiết kế', task: 'P1-10', wireframe: 'review' },
  { slug: 'noi-dung', label: 'Nội dung listing', task: 'P2-02', wireframe: 'listing' },
  { slug: 'san-pham', label: 'Sản phẩm & đẩy', task: 'P2-04', wireframe: 'products' },
  { slug: 'cua-hang', label: 'Cửa hàng & thành viên', task: 'P1-04', wireframe: 'team' },
  { slug: 'ky-nang', label: 'Kỹ năng & vận hành', task: 'P3-04', wireframe: 'skills' },
  { slug: 'ngach', label: 'Dữ liệu ngách', task: 'P3-09', wireframe: 'niche' },
] as const;

export type Screen = (typeof screens)[number];
export type ScreenSlug = Screen['slug'];

export function findScreen(slug: string): Screen | undefined {
  return screens.find((s) => s.slug === slug);
}
