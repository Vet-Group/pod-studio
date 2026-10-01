import { expect, test, type Page } from '@playwright/test';
import { createProductType, runShopifyImport, startShopifyImport, savePriceTable, saveShopifyConnection, type Principal } from '../../packages/core/src';
import { startShopifyStub } from '../support/shopify-stub';
import { seedActiveAccount, seedMember, seedStore, withDatabase, type SeededAccount } from './fixtures';
import { parseEncryptionKeys } from '../../packages/core/src/shopify/crypto';
import { randomBytes } from 'node:crypto';
import { auditLog, eq, importRuns, products } from '../../packages/db/src';

const admin = (): Principal => ({ userId: process.env.POD_E2E_ADMIN_ID!, role: 'admin' });
const principal = (a: SeededAccount): Principal => ({ userId: a.userId, role: 'member' });
async function signIn(page: Page, account: SeededAccount, path: string) {
  await page.goto(`/login?next=${encodeURIComponent(path)}`);
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(path, { timeout: 15000 });
}
async function seed() {
  const owner = await seedActiveAccount(admin(), 'Import Owner');
  const store = await seedStore(admin(), 'Shopify Import Workshop', owner.userId);
  const type = await withDatabase(async (db) => {
    const type = await createProductType(db, principal(owner), store.storeId, {
      name: 'Poster',
      currency: 'USD',
      options: [{ name: 'Size', values: ['S', 'M'] }],
    });
    await savePriceTable(db, principal(owner), store.storeId, type.id, {
      revision: 0,
      rows: [
        { optionValues: { Size: 'S' }, price: '12.50', excludedMarkets: [] },
        { optionValues: { Size: 'M' }, price: '20.00', excludedMarkets: [] },
      ],
    });
    return type;
  });
  return { owner, store, type };
}

test('owner imports in background, sees progress and error log, then resyncs; viewer cannot import', async ({
  page,
  browser,
}, testInfo) => {
  const { owner, store } = await seed();
  const path = `/stores/${store.storeId}/catalog`;
  await signIn(page, owner, path);
  await expect(page.getByRole('button', { name: 'Import from Shopify' })).toBeDisabled();
  await expect(page.getByText('Connect Shopify in store settings to import.')).toBeVisible();
  // Configure through the UI so the server uses the same ephemeral encryption key as the test connection.
  await page.goto(`/stores/${store.storeId}/settings`);
  await page.getByLabel('Client ID').fill('import-app');
  await page.getByLabel('Client secret', { exact: true }).fill('stub-secret');
  await page.getByLabel('Access token', { exact: true }).fill('stub-token');
  await page.getByRole('button', { name: 'Save credentials' }).click();
  await expect(page.getByText('Credentials saved.', { exact: true })).toBeVisible();
  await page.goto(path);
  const panel = page.getByRole('region', { name: 'Shopify imports' });
  if (process.env.IMPORT_SCREENSHOTS === '1')
    await page.screenshot({
      path: `C:/Users/Administrator/pod-studio-wt/shots/P2-10/catalog-idle-${testInfo.project.name}.png`,
      fullPage: true,
      style: 'nextjs-portal { display: none !important; }',
    });
  await panel.getByRole('button', { name: 'Import from Shopify' }).click();
  await expect(panel.getByText('Completed with errors', { exact: true })).toBeVisible({ timeout: 20000 });
  await expect(panel.getByText('Completed with errors', { exact: true })).toHaveCSS('color', 'rgb(168, 90, 54)');
  await expect(panel.getByText('2 imported · 0 skipped · 3 processed')).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Catalog products (2)' })).toBeVisible();
  await panel.getByText('Error log (1)').click();
  await expect(panel.getByText('A Shopify product could not be imported.', { exact: false })).toBeVisible();
  await expect(panel.getByText('Shopify product ID: 103.', { exact: false })).toBeVisible();
  await expect(panel.getByText('gid://shopify', { exact: false })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Resync variants for Mountain poster' }).click();
  await expect(panel.getByText('Variants resynced from the current price table. SKU preserved.')).toBeVisible();
  if (process.env.IMPORT_SCREENSHOTS === '1')
    await page.screenshot({
      path: `C:/Users/Administrator/pod-studio-wt/shots/P2-10/catalog-completed-errors-${testInfo.project.name}.png`,
      fullPage: true,
      style: 'nextjs-portal { display: none !important; }',
    });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const viewer = await seedActiveAccount(admin(), 'Import Viewer');
  await seedMember(principal(owner), store.storeId, viewer.email, 'viewer');
  const context = await browser.newContext();
  const readOnly = await context.newPage();
  await signIn(readOnly, viewer, path);
  await expect(readOnly.getByRole('button', { name: 'Import from Shopify' })).toHaveCount(0);
  await expect(readOnly.getByRole('button', { name: /Resync variants/ })).toHaveCount(0);
  await expect(readOnly.getByText('Read-only: product.edit is required to import or resync.')).toBeVisible();
  await context.close();
});

test('catalog shows an active run with progress', async ({ page }, testInfo) => {
  const { owner, store, type } = await seed();
  await withDatabase(async (db) => {
    await saveShopifyConnection(
      db,
      principal(owner),
      store.storeId,
      { clientId: 'stub', clientSecret: 'stub-secret', accessToken: 'stub-token' },
      parseEncryptionKeys(`v1:${randomBytes(32).toString('base64')}`, 'v1'),
    );
    await db
      .insert(products)
      .values({ storeId: store.storeId, productTypeId: type.id, title: 'Mountain poster', status: 'active' });
    await db
      .insert(importRuns)
      .values({
        storeId: store.storeId,
        source: 'shopify',
        ref: type.id,
        requestedBy: owner.userId,
        status: 'running',
        startedAt: new Date(),
        imported: 1,
        totalRows: 2,
        errors: ['A Shopify product could not be imported. Check its required title, status and product ID.'],
      });
  });
  await signIn(page, owner, `/stores/${store.storeId}/catalog`);
  const panel = page.getByRole('region', { name: 'Shopify imports' });
  await expect(panel.getByText('Importing', { exact: true })).toBeVisible();
  await expect(panel.getByText('Importing', { exact: true })).toHaveCSS('color', 'rgb(36, 104, 91)');
  await expect(panel.getByRole('heading', { name: 'Catalog products (1)' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Resync variants for Mountain poster' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Import from Shopify' })).toBeDisabled();
  await panel.getByText('Error log (1)').click();
  if (process.env.IMPORT_SCREENSHOTS === '1')
    await page.screenshot({
      path: `C:/Users/Administrator/pod-studio-wt/shots/P2-10/catalog-running-errors-${testInfo.project.name}.png`,
      fullPage: true,
      style: 'nextjs-portal { display: none !important; }',
    });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('store-wide busy state names the importing type and disables every import', async ({ page }, testInfo) => {
  const { owner, store, type } = await seed();
  await withDatabase(async (db) => {
    await createProductType(db, principal(owner), store.storeId, { name: 'Mug', currency: 'USD', options: [{ name: 'Size', values: ['S'] }] });
    await saveShopifyConnection(db, principal(owner), store.storeId, { clientId: 'stub', clientSecret: 'stub-secret', accessToken: 'stub-token' }, parseEncryptionKeys(`v1:${randomBytes(32).toString('base64')}`, 'v1'));
    await db.insert(importRuns).values({ storeId: store.storeId, source: 'shopify', ref: type.id, requestedBy: owner.userId, status: 'running', startedAt: new Date() });
  });
  await signIn(page, owner, `/stores/${store.storeId}/catalog`);
  const panel = page.getByRole('region', { name: 'Shopify imports' });
  const buttons = panel.getByRole('button', { name: 'Import from Shopify' });
  await expect(buttons).toHaveCount(2);
  await expect(buttons.nth(0)).toBeDisabled();
  await expect(buttons.nth(1)).toBeDisabled();
  await expect(panel.getByText('Poster is importing. Wait for it to finish before starting another import for this store.')).toHaveCount(2);
  if (process.env.IMPORT_SCREENSHOTS === '1') await page.screenshot({ path: `C:/Users/Administrator/pod-studio-wt/shots/P2-10/catalog-store-busy-other-type-${testInfo.project.name}.png`, fullPage: true, style: 'nextjs-portal { display: none !important; }' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('progress API rejects anonymous and nonmember access without exposing runs', async ({ page, request }) => {
  const { owner, store, type } = await seed();
  const run = await withDatabase(async (db) => {
    const [run] = await db.insert(importRuns).values({ storeId: store.storeId, source: 'shopify', ref: type.id, errors: ['private run details'] }).returning();
    return run!;
  });
  const url = `/api/stores/${store.storeId}/imports`;
  const anonymous = await request.get(url);
  expect(anonymous.status()).toBe(401);
  expect(await anonymous.json()).toEqual({ code: 'UNAUTHORIZED', message: 'Sign in to continue.' });
  const outsider = await seedActiveAccount(admin(), 'Import outsider');
  await signIn(page, outsider, '/stores');
  const denied = await page.request.get(url);
  expect(denied.status()).toBe(404);
  expect(await denied.json()).toEqual({ error: 'Store not found.' });
  expect(await denied.text()).not.toContain(run.id);
  expect(await denied.text()).not.toContain('private run details');
  expect(owner.userId).not.toBe(outsider.userId);
});

test('failed upstream import exposes only safe errors in the API and UI', async ({ page }) => {
  const { owner, store, type } = await seed();
  const raw = 'raw upstream failure shpat_fake_upstream_token';
  const keys = parseEncryptionKeys(`v1:${randomBytes(32).toString('base64')}`, 'v1');
  const stub = await startShopifyStub([{ status: 401, body: { errors: [{ message: raw }] } }]);
  try {
    await withDatabase(async (db) => {
      await saveShopifyConnection(db, principal(owner), store.storeId, { clientId: 'stub', clientSecret: 'stub-secret', accessToken: 'shpat_fake_upstream_token' }, keys);
      const run = await startShopifyImport(db, principal(owner), store.storeId, type.id);
      await runShopifyImport(db, run.id, { keys, endpoint: stub.url, environment: 'test' });
      const rows = await db.select().from(auditLog).where(eq(auditLog.storeId, store.storeId));
      expect(JSON.stringify(rows)).not.toContain(raw);
      expect(JSON.stringify(rows)).not.toContain('shpat_fake_upstream_token');
    });
    await signIn(page, owner, `/stores/${store.storeId}/catalog`);
    const response = await page.request.get(`/api/stores/${store.storeId}/imports`);
    expect(response.status()).toBe(200);
    const body = await response.text();
    expect(body).not.toContain(raw);
    expect(body).not.toContain('shpat_fake_upstream_token');
    const panel = page.getByRole('region', { name: 'Shopify imports' });
    await expect(panel.getByText('Failed', { exact: true })).toBeVisible();
    await expect(panel.getByText('Failed', { exact: true })).toHaveCSS('color', 'rgb(168, 90, 54)');
    await panel.getByText('Error log (1)').click();
    await expect(panel.getByText('Import stopped. Check Shopify connection and store permissions, then start a new import.')).toBeVisible();
    expect(await panel.innerText()).not.toContain(raw);
    expect(await panel.innerText()).not.toContain('shpat_fake_upstream_token');
  } finally { await stub.close(); }
});
