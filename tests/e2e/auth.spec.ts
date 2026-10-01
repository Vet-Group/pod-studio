import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { Principal } from '../../packages/core/src';
import { seedInvite, seedTemporaryAccount, withDatabase } from './fixtures';
import { eq, sessions } from '../../packages/db/src';

const admin = (): Principal => ({ userId: process.env.POD_E2E_ADMIN_ID!, role: 'admin' });

async function signIn(page: Page, email: string, password: string) {
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function expectNoAxeViolations(page: Page, label: string) {
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.length}`), label).toEqual([]);
}

test.describe('anonymous visitors', () => {
  test('are sent to sign-in and returned to the page they asked for', async ({ page }) => {
    await page.goto('/review');
    await expect(page).toHaveURL(/\/login\?next=%2Freview$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();

    await signIn(page, process.env.POD_E2E_ADMIN_EMAIL!, process.env.POD_E2E_ADMIN_PASSWORD!);
    await expect(page).toHaveURL(/\/review$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Design review');
  });

  test('get a clear error for a wrong password and stay on the form', async ({ page }) => {
    await page.goto('/login');
    await signIn(page, process.env.POD_E2E_ADMIN_EMAIL!, 'definitely-not-the-password');
    await expect(page.locator('form').getByRole('alert')).toHaveText('That email and password do not match an account.');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('cannot be bounced to another site after sign-in', async ({ page }) => {
    await page.goto('/login?next=//evil.example/steal');
    await signIn(page, process.env.POD_E2E_ADMIN_EMAIL!, process.env.POD_E2E_ADMIN_PASSWORD!);
    await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/studio$/);
  });

  test('get 401 from app APIs instead of a page', async ({ request }) => {
    const response = await request.get('/api/stores');
    expect(response.status()).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

test.describe('invite links', () => {
  test('let a newcomer set a password, land in the app, and work only once', async ({ page }) => {
    const invite = await seedInvite(admin());
    await page.goto(`/invite/${invite.token}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Join POD Studio' })).toBeVisible();
    await expect(page.getByLabel('Email')).toHaveValue(invite.email);
    await expectNoAxeViolations(page, 'invite');

    await page.getByLabel('Your name').fill('Riley Newcomer');
    await page.getByLabel('Password', { exact: true }).fill('newcomer-password-1');
    await page.getByLabel('Confirm password').fill('newcomer-password-2');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByText('The two passwords do not match.')).toBeVisible();

    await page.getByLabel('Confirm password').fill('newcomer-password-1');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page).toHaveURL(/\/studio$/);
    await expect(page.getByText('Riley Newcomer')).toBeVisible();

    // The same link a second time: explained, not a form.
    await page.goto(`/invite/${invite.token}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('This invite link was already used');
  });

  test('explain a link that does not exist', async ({ page }) => {
    await page.goto('/invite/not-a-real-token');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('This invite link does not work');
    await expect(page.getByRole('link', { name: 'Go to sign in' })).toBeVisible();
  });
});

test.describe('temporary passwords', () => {
  test('force a change at first sign-in, then open the app', async ({ page }) => {
    const account = await seedTemporaryAccount(admin(), 'Taylor Staff');
    await page.goto('/login');
    await signIn(page, account.email, account.password);
    await expect(page).toHaveURL(/\/change-password$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Choose your password' })).toBeVisible();
    await expectNoAxeViolations(page, 'change-password');

    // Every other page bounces back while the password is still temporary.
    await page.goto('/studio');
    await expect(page).toHaveURL(/\/change-password$/);

    await page.getByLabel('Temporary password').fill(account.password);
    await page.getByLabel('New password', { exact: true }).fill(account.password);
    await page.getByLabel('Confirm new password').fill(account.password);
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await expect(page.locator('form').getByRole('alert')).toHaveText('The new password must differ from the current one.');

    await page.getByLabel('New password', { exact: true }).fill('taylor-own-password-1');
    await page.getByLabel('Confirm new password').fill('taylor-own-password-1');
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await expect(page).toHaveURL(/\/studio$/);
    await expect(page.getByText('Taylor Staff')).toBeVisible();
  });
});

test.describe('signing out', () => {
  test('deletes the session row and closes the app again', async ({ page }) => {
    const account = await seedTemporaryAccount(admin(), 'Sam Signout');
    await page.goto('/login');
    await signIn(page, account.email, account.password);
    await page.getByLabel('Temporary password').fill(account.password);
    await page.getByLabel('New password', { exact: true }).fill('sam-own-password-1');
    await page.getByLabel('Confirm new password').fill('sam-own-password-1');
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await expect(page).toHaveURL(/\/studio$/);

    const count = () => withDatabase((db) => db.$count(sessions, eq(sessions.userId, account.userId)));
    expect(await count()).toBe(1);

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/);
    expect(await count()).toBe(0);

    await page.goto('/studio');
    await expect(page).toHaveURL(/\/login\?next=%2Fstudio$/);
  });
});

test('the sign-in page has no axe violations and no horizontal overflow', async ({ page }) => {
  await page.goto('/login');
  await expectNoAxeViolations(page, 'login');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
