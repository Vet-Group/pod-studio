import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const screens = [
  ['thiet-ke', 'Thư viện thiết kế'],
  ['duyet', 'Duyệt thiết kế'],
  ['noi-dung', 'Nội dung listing'],
  ['san-pham', 'Sản phẩm & đẩy'],
  ['cua-hang', 'Cửa hàng & thành viên'],
  ['ky-nang', 'Kỹ năng & vận hành'],
  ['ngach', 'Dữ liệu ngách'],
] as const;

test('the root redirects to the design library', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/thiet-ke$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Thư viện thiết kế');
});

test('every screen is reachable from the navigation and marks itself current', async ({ page }) => {
  await page.goto('/thiet-ke');
  const nav = page.getByRole('navigation', { name: 'Điều hướng chính' });
  for (const [slug, label] of screens) {
    await nav.locator(`a[href="/${slug}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/${slug}$`));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(label);
    await expect(nav.locator(`a[href="/${slug}"]`)).toHaveAttribute('aria-current', 'page');
  }
});

test('unknown routes show the not-found page', async ({ page }) => {
  const res = await page.goto('/khong-ton-tai');
  expect(res?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Không tìm thấy trang' })).toBeVisible();
});

test('no horizontal overflow and no axe violations', async ({ page }) => {
  for (const [slug] of screens) {
    await page.goto(`/${slug}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, slug).toBeLessThanOrEqual(0);
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    expect(axe.violations.map((v) => `${v.id}: ${v.nodes.length}`), slug).toEqual([]);
  }
});

test('the current navigation item keeps a readable label', async ({ page }) => {
  // Regression: a `bg-current` class once painted the item in its own text colour.
  await page.goto('/duyet');
  const link = page.getByRole('navigation', { name: 'Điều hướng chính' }).locator('a[aria-current="page"]');
  await expect(link).toHaveCount(1);
  const ratio = await link.evaluate((el) => {
    const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const lum = (c: string) => {
      const [r = 0, g = 0, b = 0] = rgb(c).map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const style = getComputedStyle(el);
    const [hi, lo] = [lum(style.color), lum(style.backgroundColor)].sort((a, b) => b - a) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  });
  expect(ratio).toBeGreaterThanOrEqual(4.5);
});

test('phones keep the navigation above the content, in page flow like the wireframe', async ({ page }, info) => {
  // Regression: a fixed bottom bar diverged from the wireframe and needed padding to avoid covering content.
  test.skip(info.project.name !== 'mobile', 'phone layout only');
  await page.goto('/duyet');
  const nav = page.getByRole('navigation', { name: 'Điều hướng chính' });
  const layout = await nav.evaluate((el) => {
    const aside = el.closest('aside')!;
    const heading = document.querySelector('h1')!.getBoundingClientRect();
    const items = [...el.querySelectorAll('a')].map((a) => a.getBoundingClientRect());
    const rows = new Map<number, number[]>();
    for (const r of items) rows.set(Math.round(r.top), [...(rows.get(Math.round(r.top)) ?? []), Math.round(r.height)]);
    return {
      position: getComputedStyle(aside).position,
      navBottom: el.getBoundingClientRect().bottom,
      headingTop: heading.top,
      rowHeights: [...rows.values()].map((hs) => new Set(hs).size),
    };
  });
  expect(layout.position).toBe('static');
  expect(layout.navBottom).toBeLessThanOrEqual(layout.headingTop);
  // Items in the same grid row share one height, whatever their label length.
  expect(layout.rowHeights.every((n) => n === 1)).toBe(true);
});

test('the skip link moves keyboard focus to the main content', async ({ page }) => {
  await page.goto('/duyet');
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Đến nội dung chính' });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press('Enter');
  await expect(page.locator('main#main')).toBeFocused();
});

test('navigation targets are at least 44px on phones', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'phone-only floor');
  await page.goto('/thiet-ke');
  const sizes = await page
    .getByRole('navigation', { name: 'Điều hướng chính' })
    .locator('a')
    .evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => Math.min(r.width, r.height)));
  expect(sizes).toHaveLength(screens.length);
  for (const s of sizes) expect(s).toBeGreaterThanOrEqual(44);
});
