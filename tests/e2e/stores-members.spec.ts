import { expect, test, type Page } from '@playwright/test';
import type { Principal } from '../../packages/core/src';
import { eq, users } from '../../packages/db/src';
import {
  membershipOf,
  seedActiveAccount,
  seedMember,
  seedStore,
  storeAudit,
  uniqueEmail,
  uniqueShopDomain,
  withDatabase,
  type SeededAccount,
} from './fixtures';

/**
 * P1-04 end to end: an admin creates a store, its owner invites people, changes roles and single
 * permissions, hands ownership over and removes members. Each test seeds its own accounts and store
 * (tests run in parallel against one database) and checks the audit trail the action left behind.
 */

const admin = (): Principal => ({ userId: process.env.POD_E2E_ADMIN_ID!, role: 'admin' });
const principal = (account: SeededAccount): Principal => ({ userId: account.userId, role: 'member' });

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Signs in through the login form and lands on `path`. */
async function signInTo(page: Page, account: SeededAccount, path: string) {
  await page.goto(`/login?next=${encodeURIComponent(path)}`);
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(new RegExp(`${escapeRegExp(path)}$`));
}

/** Drops the session so the same page can sign in as someone else. */
async function signOut(page: Page) {
  await page.context().clearCookies();
}

const membersPath = (storeId: string) => `/stores/${storeId}/members`;
const memberRow = (page: Page, email: string) => page.getByRole('row').filter({ hasText: email });

async function auditActions(storeId: string): Promise<string[]> {
  return (await storeAudit(storeId)).map((row) => row.action);
}

async function userIdOf(email: string): Promise<string | undefined> {
  return withDatabase(async (db) => {
    const [row] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    return row?.id;
  });
}

test.describe('an admin', () => {
  test.use({ storageState: process.env.POD_E2E_ADMIN_STATE });

  test('creates a store with an owner and lands on its members', async ({ page }) => {
    const owner = await seedActiveAccount(admin(), 'Olive Owner');
    const storeName = `Harbor Prints ${owner.userId.slice(0, 6)}`;

    await page.goto('/stores');
    await page.getByRole('button', { name: '+ New store' }).click();
    const dialog = page.getByRole('dialog', { name: 'New store' });
    await dialog.getByLabel('Store name').fill(storeName);
    await dialog.getByLabel('Shopify domain').fill(uniqueShopDomain('harbor'));
    await dialog.getByLabel('Store owner').selectOption({ label: `Olive Owner (${owner.email})` });
    await dialog.getByRole('button', { name: 'Create store' }).click();

    await expect(page).toHaveURL(/\/stores\/[A-Za-z0-9_-]+\/members$/);
    const storeId = new URL(page.url()).pathname.split('/')[2]!;
    await expect(page.getByRole('heading', { level: 2, name: `Members of ${storeName}` })).toBeVisible();
    await expect(page.getByText('Viewing as admin.', { exact: false })).toBeVisible();
    await expect(memberRow(page, owner.email)).toContainText('Store owner');
    await expect(page.getByText('1 member', { exact: true })).toBeVisible();
    // The admin manages members but holds no membership of its own here.
    await expect(page.getByRole('link', { name: new RegExp(escapeRegExp(storeName)) })).toContainText('You: admin access');

    expect(await membershipOf(storeId, owner.userId)).toMatchObject({ role: 'owner' });
    expect(await membershipOf(storeId, admin().userId)).toBeNull();
    const audit = await storeAudit(storeId);
    expect(audit.map((row) => row.action)).toEqual(['store.create']);
    expect(audit[0]).toMatchObject({ actorUserId: admin().userId, targetId: storeId });
  });
});

test.describe('a store owner', () => {
  test('invites a newcomer, adds an existing account and is told about duplicates', async ({ page }) => {
    const owner = await seedActiveAccount(admin(), 'Olive Owner');
    const existing = await seedActiveAccount(admin(), 'Sam Seller');
    const storeName = `Invite Lab ${owner.userId.slice(0, 6)}`;
    const { storeId } = await seedStore(admin(), storeName, owner.userId);
    const newcomer = uniqueEmail('newcomer');

    await signInTo(page, owner, membersPath(storeId));
    await expect(page.getByText('Viewing as store owner.')).toBeVisible();

    // A newcomer gets a one-time link; the role fills the permission checkboxes.
    await page.getByRole('button', { name: '+ Invite member' }).click();
    let dialog = page.getByRole('dialog', { name: `Invite to ${storeName}` });
    await dialog.getByLabel('Email').fill(newcomer);
    await dialog.getByLabel('Store role').selectOption({ label: 'Designer' });
    await expect(dialog.getByLabel('View store')).toBeChecked();
    await expect(dialog.getByLabel('Edit products')).not.toBeChecked();
    await dialog.getByRole('button', { name: 'Send invite' }).click();
    dialog = page.getByRole('dialog', { name: 'Invite link ready' });
    const link = await dialog.getByLabel('Invite link').inputValue();
    expect(new URL(link).pathname).toMatch(/^\/invite\/[A-Za-z0-9_-]+$/);
    await dialog.getByRole('button', { name: 'Done' }).click();

    const pending = page.getByRole('region', { name: 'Pending invites' });
    await expect(pending.getByRole('listitem').filter({ hasText: newcomer })).toContainText('Designer · expires');

    // An existing account joins at once.
    await page.getByRole('button', { name: '+ Invite member' }).click();
    dialog = page.getByRole('dialog', { name: `Invite to ${storeName}` });
    await dialog.getByLabel('Email').fill(existing.email);
    await dialog.getByLabel('Store role').selectOption({ label: 'Seller' });
    await dialog.getByRole('button', { name: 'Send invite' }).click();
    await expect(page.getByRole('dialog', { name: 'Member added' })).toBeVisible();
    await page.getByRole('dialog', { name: 'Member added' }).getByRole('button', { name: 'Done' }).click();
    await expect(memberRow(page, existing.email)).toBeVisible();
    await expect(page.getByLabel('Store role for Sam Seller')).toHaveValue('seller');

    // Inviting someone who is already in the store is refused with a reason.
    await page.getByRole('button', { name: '+ Invite member' }).click();
    dialog = page.getByRole('dialog', { name: `Invite to ${storeName}` });
    await dialog.getByLabel('Email').fill(existing.email);
    await dialog.getByRole('button', { name: 'Send invite' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('This person is already a member of the store.');
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    expect(await membershipOf(storeId, existing.userId)).toEqual({
      role: 'seller',
      permissions: ['store.view', 'analysis.run', 'product.edit', 'content.generate'],
    });
    expect(await auditActions(storeId)).toEqual(['store.create', 'invite.create', 'store.member.add']);

    // The newcomer accepts the link and lands in the store with the invited role.
    await signOut(page);
    await page.goto(new URL(link).pathname);
    await page.getByLabel('Your name').fill('Nia Newcomer');
    await page.getByLabel('Password', { exact: true }).fill('newcomer-password-1');
    await page.getByLabel('Confirm password').fill('newcomer-password-1');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page).toHaveURL(/\/studio$/);

    await page.goto('/stores');
    await expect(page.getByRole('link', { name: new RegExp(escapeRegExp(storeName)) })).toContainText('You: Designer');
    await page.goto(membersPath(storeId));
    await expect(memberRow(page, newcomer)).toContainText('(you)');

    const newcomerId = await userIdOf(newcomer);
    expect(newcomerId).toBeTruthy();
    expect(await membershipOf(storeId, newcomerId!)).toEqual({ role: 'designer', permissions: ['store.view'] });
    const accepted = (await storeAudit(storeId)).at(-1);
    expect(accepted).toMatchObject({ action: 'invite.accept', actorUserId: newcomerId });
  });

  test('revokes a pending invite so its link stops working', async ({ page }) => {
    const owner = await seedActiveAccount(admin(), 'Olive Owner');
    const storeName = `Revoke Lab ${owner.userId.slice(0, 6)}`;
    const { storeId } = await seedStore(admin(), storeName, owner.userId);
    const invitee = uniqueEmail('invitee');

    await signInTo(page, owner, membersPath(storeId));
    await page.getByRole('button', { name: '+ Invite member' }).click();
    let dialog = page.getByRole('dialog', { name: `Invite to ${storeName}` });
    await dialog.getByLabel('Email').fill(invitee);
    await dialog.getByRole('button', { name: 'Send invite' }).click();
    dialog = page.getByRole('dialog', { name: 'Invite link ready' });
    const path = new URL(await dialog.getByLabel('Invite link').inputValue()).pathname;
    await dialog.getByRole('button', { name: 'Done' }).click();

    const pending = page.getByRole('region', { name: 'Pending invites' });
    await pending.getByRole('button', { name: `Revoke invite for ${invitee}` }).click();
    await expect(pending.getByText(invitee)).toHaveCount(0);
    await expect(pending.getByText('No pending invites.', { exact: false })).toBeVisible();
    expect(await auditActions(storeId)).toEqual(['store.create', 'invite.create', 'invite.revoke']);

    await signOut(page);
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('This invite link was withdrawn');
  });

  test("changes a member's role and toggles single permissions", async ({ page }) => {
    const owner = await seedActiveAccount(admin(), 'Olive Owner');
    const seller = await seedActiveAccount(admin(), 'Sam Seller');
    const { storeId } = await seedStore(admin(), `Role Lab ${owner.userId.slice(0, 6)}`, owner.userId);
    await seedMember(principal(owner), storeId, seller.email, 'seller');

    await signInTo(page, owner, membersPath(storeId));
    await expect(page.getByLabel('Edit products for Sam Seller')).toBeChecked();

    // A new role resets the permissions to that role's preset.
    await page.getByLabel('Store role for Sam Seller').selectOption({ label: 'Designer' });
    await expect(page.getByLabel('Edit products for Sam Seller')).not.toBeChecked();
    await expect(page.getByLabel('Store role for Sam Seller')).toHaveValue('designer');
    await expect.poll(() => membershipOf(storeId, seller.userId)).toEqual({ role: 'designer', permissions: ['store.view'] });

    // Then single permissions can be switched on and off on top of the preset. The boxes are
    // controlled by the saved state, so click and wait for the server round trip instead of check().
    await page.getByLabel('Draft push for Sam Seller').click();
    await expect(page.getByLabel('Draft push for Sam Seller')).toBeChecked();
    await expect
      .poll(() => membershipOf(storeId, seller.userId))
      .toEqual({ role: 'designer', permissions: ['store.view', 'product.push'] });

    await page.reload();
    await expect(page.getByLabel('Draft push for Sam Seller')).toBeChecked();
    await page.getByLabel('Draft push for Sam Seller').click();
    await expect(page.getByLabel('Draft push for Sam Seller')).not.toBeChecked();
    await expect.poll(() => membershipOf(storeId, seller.userId)).toEqual({ role: 'designer', permissions: ['store.view'] });

    expect(await auditActions(storeId)).toEqual([
      'store.create',
      'store.member.add',
      'store.member.update',
      'store.member.update',
      'store.member.update',
    ]);
  });

  test('transfers ownership and stays on as a co-leader', async ({ page }) => {
    const owner = await seedActiveAccount(admin(), 'Olive Owner');
    const lead = await seedActiveAccount(admin(), 'Casey Lead');
    const storeName = `Transfer Lab ${owner.userId.slice(0, 6)}`;
    const { storeId } = await seedStore(admin(), storeName, owner.userId);
    await seedMember(principal(owner), storeId, lead.email, 'co_leader');

    await signInTo(page, owner, membersPath(storeId));
    await memberRow(page, lead.email).getByRole('button', { name: 'Make owner' }).click();
    const dialog = page.getByRole('dialog', { name: `Make Casey Lead the owner of ${storeName}?` });
    await dialog.getByRole('button', { name: 'Transfer ownership' }).click();

    await expect(page.getByText('Viewing as co-leader.')).toBeVisible();
    await expect(memberRow(page, lead.email)).toContainText('Store owner');
    // Only the owner (or an admin) may hand the store over, so the button is gone for the old owner.
    await expect(page.getByRole('button', { name: 'Make owner' })).toHaveCount(0);

    expect(await membershipOf(storeId, lead.userId)).toMatchObject({ role: 'owner' });
    expect(await membershipOf(storeId, owner.userId)).toMatchObject({ role: 'co_leader' });
    const transfer = (await storeAudit(storeId)).at(-1);
    expect(transfer).toMatchObject({ action: 'store.owner.transfer', actorUserId: owner.userId, targetId: lead.userId });

    // The new owner now runs the store.
    await signOut(page);
    await signInTo(page, lead, membersPath(storeId));
    await expect(page.getByText('Viewing as store owner.')).toBeVisible();
    await expect(memberRow(page, owner.email).getByRole('button', { name: 'Make owner' })).toBeVisible();
  });

  test('removes a member, who then cannot open the store', async ({ page }) => {
    const owner = await seedActiveAccount(admin(), 'Olive Owner');
    const seller = await seedActiveAccount(admin(), 'Sam Seller');
    const storeName = `Remove Lab ${owner.userId.slice(0, 6)}`;
    const { storeId } = await seedStore(admin(), storeName, owner.userId);
    await seedMember(principal(owner), storeId, seller.email, 'seller');

    await signInTo(page, owner, membersPath(storeId));
    await expect(page.getByText('2 members', { exact: true })).toBeVisible();
    await memberRow(page, seller.email).getByRole('button', { name: 'Remove', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: `Remove Sam Seller from ${storeName}?` });
    await dialog.getByRole('button', { name: 'Remove member' }).click();

    await expect(memberRow(page, seller.email)).toHaveCount(0);
    await expect(page.getByText('1 member', { exact: true })).toBeVisible();
    expect(await membershipOf(storeId, seller.userId)).toBeNull();
    const removal = (await storeAudit(storeId)).at(-1);
    expect(removal).toMatchObject({ action: 'store.member.remove', actorUserId: owner.userId, targetId: seller.userId });

    // Same answer as for a store that does not exist, so ids cannot be probed.
    await signOut(page);
    await signInTo(page, seller, membersPath(storeId));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Page not found');
    await page.goto('/stores');
    await expect(page.getByText('You are not a member of any store yet.', { exact: false })).toBeVisible();
  });
});

test.describe('a store member', () => {
  test('without member management sees the store read-only', async ({ page }) => {
    const owner = await seedActiveAccount(admin(), 'Olive Owner');
    const viewer = await seedActiveAccount(admin(), 'Vic Viewer');
    const { storeId } = await seedStore(admin(), `Viewer Lab ${owner.userId.slice(0, 6)}`, owner.userId);
    await seedMember(principal(owner), storeId, viewer.email, 'viewer');

    await signInTo(page, viewer, membersPath(storeId));
    await expect(page.getByText('Viewing as viewer (read-only).')).toBeVisible();
    await expect(page.getByRole('button', { name: '+ Invite member' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Make owner' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Remove', exact: true })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Pending invites' })).toHaveCount(0);
    await expect(page.getByLabel('Store role for Vic Viewer')).toHaveCount(0);
    await expect(page.getByLabel('Draft push for Olive Owner')).toBeDisabled();
  });

  test('can leave a store and lands on the store list', async ({ page }) => {
    const owner = await seedActiveAccount(admin(), 'Olive Owner');
    const seller = await seedActiveAccount(admin(), 'Sam Seller');
    const storeName = `Leave Lab ${owner.userId.slice(0, 6)}`;
    const { storeId } = await seedStore(admin(), storeName, owner.userId);
    await seedMember(principal(owner), storeId, seller.email, 'seller');

    await signInTo(page, seller, membersPath(storeId));
    await memberRow(page, seller.email).getByRole('button', { name: 'Leave store' }).click();
    await page.getByRole('dialog', { name: `Leave ${storeName}?` }).getByRole('button', { name: 'Leave store' }).click();

    await expect(page).toHaveURL(/\/stores$/);
    await expect(page.getByText('You are not a member of any store yet.', { exact: false })).toBeVisible();
    expect(await membershipOf(storeId, seller.userId)).toBeNull();
    const left = (await storeAudit(storeId)).at(-1);
    expect(left).toMatchObject({ action: 'store.member.remove', actorUserId: seller.userId, targetId: seller.userId });
    expect(left?.data).toMatchObject({ self: true });
  });
});
