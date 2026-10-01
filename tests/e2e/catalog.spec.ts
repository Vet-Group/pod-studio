import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createProductType, savePriceTable, type Principal } from '../../packages/core/src';
import { seedActiveAccount, seedMember, seedStore, storeAudit, withDatabase, type SeededAccount } from './fixtures';

const admin = (): Principal => ({
  userId: process.env.POD_E2E_ADMIN_ID!,
  role: 'admin',
});
const principal = (account: SeededAccount): Principal => ({
  userId: account.userId,
  role: 'member',
});
async function signIn(page: Page, account: SeededAccount, path: string) {
  await page.goto(`/login?next=${encodeURIComponent(path)}`);
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(path, { timeout: 15_000 });
}

test('owner creates a type, edits price cells, validates, reorders and saves rows', async ({ page }, testInfo) => {
  const owner = await seedActiveAccount(admin(), 'Catalog Owner');
  const store = await seedStore(admin(), 'Catalog Workshop', owner.userId);
  await signIn(page, owner, '/stores');
  await page;
  page
    .locator('li')
    .filter({ hasText: 'Catalog Workshop' })
    .getByRole('link', { name: 'Catalog', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Catalog', exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('heading', { name: 'No product types yet' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create product type' })).toBeEnabled();
  if (process.env.CATALOG_SCREENSHOTS === '1') {
    await page.screenshot({ path: `C:/Users/Administrator/pod-studio-wt/shots/P2-03/catalog-empty-${testInfo.project.name}.png`, fullPage: true, style: 'nextjs-portal { display: none !important; }' });
  }
  await page.getByLabel('Product type name').fill('T-shirt');
  await page.getByLabel('Option 1 name').fill('Size');
  await page.getByLabel('Option 1 values').fill('S, M, L');
  await page.getByRole('button', { name: 'Add option' }).click();
  await page.getByLabel('Option 2 name').fill('Color');
  await page.getByLabel('Option 2 values').fill('White, Black');
  await page.getByRole('button', { name: 'Create product type' }).click();
  await expect(page.getByRole('heading', { name: 'Price table: T-shirt' })).toBeVisible();
  await page.getByRole('button', { name: 'Add price row' }).click();
  await page.getByLabel('Row 1 Size').selectOption('M');
  await page.getByLabel('Row 1 price').fill('19.99');
  await page.getByRole('button', { name: 'Save price table' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Row 1: Color is required.' })).toContainText(
    'Row 1: Color is required.',
  );
  await page.getByLabel('Row 1 Color').selectOption('White');
  await page.getByLabel('Row 1 excluded markets').fill('DE, FR');
  await page.getByRole('button', { name: 'Add price row' }).click();
  await page.getByLabel('Row 2 Size').selectOption('S');
  await page.getByLabel('Row 2 Color').selectOption('Black');
  await page.getByLabel('Row 2 price').fill('20.10');
  await page.getByRole('button', { name: 'Move row 2 up', exact: true }).click();
  await expect(page.getByLabel('Row 1 Size')).toHaveValue('S');
  await page.getByRole('button', { name: 'Save price table' }).click();
  await expect(page.getByRole('status')).toContainText('Price table saved. 2 variants');
  await page.reload();
  await expect(page.getByLabel('Row 1 price')).toHaveValue('20.10');
  await expect(page.getByLabel('Row 2 excluded markets')).toHaveValue('DE, FR');
  await expect(page.getByText('2 rows = 2 variants', { exact: true })).toBeVisible();
  const audit = await storeAudit(store.storeId);
  expect(audit.filter((entry) => entry.action.startsWith('catalog.')).map((entry) => entry.action)).toEqual([
    'catalog.type.create',
    'catalog.pricing.save',
  ]);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  if (process.env.CATALOG_SCREENSHOTS === '1') {
    await page.screenshot({
      path: `C:/Users/Administrator/pod-studio-wt/shots/P2-03/catalog-${testInfo.project.name}.png`,
      fullPage: true,
      style: 'nextjs-portal { display: none !important; }',
    });
  }
  await page.getByLabel('Row 1 price').fill('22.00');
  await page.getByText('Edit product type options', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save product type', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await page.getByRole('textbox', { name: 'Product type name', exact: true }).first().fill('Premium T-shirt');
  await expect(page.getByLabel('Row 1 price')).toBeDisabled();
  await page.getByRole('button', { name: 'Save product type', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Price table: Premium T-shirt' })).toBeVisible();
  await expect(page.getByLabel('Row 1 price')).toHaveValue('20.10');
  await page.getByRole('button', { name: 'Remove row 2', exact: true }).click();
  await page.getByRole('button', { name: 'Save price table' }).click();
  await expect(page.getByRole('status')).toContainText('Price table saved. 1 variant');
  await page.reload();
  await expect(page.getByLabel('Row 2 price')).toHaveCount(0);
});

test('member without store.settings sees a read-only price table', async ({ page }) => {
  const owner = await seedActiveAccount(admin(), 'Catalog Leader');
  const viewer = await seedActiveAccount(admin(), 'Catalog Viewer');
  const store = await seedStore(admin(), 'Read-only catalog', owner.userId);
  await seedMember(principal(owner), store.storeId, viewer.email, 'viewer');
  await withDatabase(async (db) => {
    const type = await createProductType(db, principal(owner), store.storeId, {
      name: 'Mug',
      currency: 'USD',
      options: [{ name: 'Size', values: ['11 oz'] }],
    });
    await savePriceTable(db, principal(owner), store.storeId, type.id, {
      revision: type.revision,
      rows: [
        {
          optionValues: { Size: '11 oz' },
          price: '12.29',
          excludedMarkets: ['DE'],
        },
      ],
    });
  });
  await signIn(page, viewer, `/stores/${store.storeId}/catalog`);
  await expect(page.getByText('Read-only: store.settings is required to edit.')).toBeVisible();
  await expect(page.getByLabel('Row 1 price')).toHaveValue('12.29');
  await expect(page.getByLabel('Row 1 price')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Add price row' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save price table' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Create product type' })).toHaveCount(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
