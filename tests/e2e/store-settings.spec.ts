import { expect, test, type Page } from '@playwright/test';
import { seedActiveAccount, seedStore, seedMember, withDatabase, type SeededAccount } from './fixtures';
import { auditLog, eq, shopifyConnections } from '../../packages/db/src';
import AxeBuilder from '@axe-core/playwright';

async function signIn(page: Page, account: SeededAccount, storeId: string) {
  const path = `/stores/${storeId}/settings`;
  await page.goto(`/login?next=${encodeURIComponent(path)}`);
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${path}$`));
}

test('owner connects to the deterministic Shopify stub; credentials remain masked; members cannot edit', async ({ page }) => {
  const admin = { userId: process.env.POD_E2E_ADMIN_ID!, role: 'admin' as const };
  const owner = await seedActiveAccount(admin, 'Settings owner');
  const { storeId } = await seedStore(admin, 'Shopify demo', owner.userId);
  const member = await seedActiveAccount(admin, 'Settings viewer');
  await seedMember({ userId: owner.userId, role: 'member' }, storeId, member.email, 'seller');
  await signIn(page, owner, storeId);
  await page.goto(`/stores/${storeId}/members`);
  await page.getByRole('link', { name: 'Store settings', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/stores/${storeId}/settings$`));
  await expect(page.getByRole('heading', { name: 'Shopify connection' })).toBeVisible();
  await expect(page.getByText('Not configured', { exact: true })).toBeVisible();
  await page.getByLabel('Client ID', { exact: true }).fill('stub-app-id');
  await page.getByLabel('Client secret', { exact: true }).fill('e2e_private_client_secret');
  await page.getByLabel('Access token', { exact: true }).fill('shpat_e2e_private_token');
  await page.getByRole('button', { name: 'Save credentials' }).click();
  await expect(page.getByText('Credentials saved.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Client secret', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: 'Test connection', exact: true }).click();
  await expect(page.getByText('Connected', { exact: true })).toBeVisible();
  await page.reload();
  const html = await page.content();
  for (const secret of ['e2e_private_client_secret', 'shpat_e2e_private_token']) expect(html).not.toContain(secret);
  const persisted = await withDatabase(async (db) => ({ rows: await db.select().from(shopifyConnections).where(eq(shopifyConnections.storeId, storeId)), audit: await db.select().from(auditLog).where(eq(auditLog.storeId, storeId)) }));
  for (const secret of ['e2e_private_client_secret', 'shpat_e2e_private_token']) expect(JSON.stringify(persisted)).not.toContain(secret);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  if (test.info().project.name === 'desktop') {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: 'C:/Users/Administrator/pod-studio-wt/shots/P2-05/desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: 'C:/Users/Administrator/pod-studio-wt/shots/P2-05/mobile.png', fullPage: true });
  }
  await page.context().clearCookies();
  await signIn(page, member, storeId);
  await page.goto(`/stores/${storeId}/members`);
  await page.getByRole('link', { name: 'Store settings', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/stores/${storeId}/settings$`));
  await expect(page.getByText('Connected', { exact: true })).toBeVisible();
  await expect(page.getByText('You do not have permission to edit this connection.')).toBeVisible();
  await expect(page.getByLabel('Client secret', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save credentials' })).toHaveCount(0);
});
