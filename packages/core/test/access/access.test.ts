import { afterEach, describe, expect, it } from 'vitest';
import { auditLog, createDatabase, eq, migrateDatabase, storeMembers, stores, users, type Database } from '@pod-studio/db';
import { createTestDatabase } from '../../../../tests/support/db';
import {
  ADMIN_STORE_PERMISSIONS,
  AuthError,
  ROLE_PRESETS,
  STORE_PERMISSIONS,
  acceptInvite,
  addMember,
  can,
  createInvite,
  createStore,
  createStoreAccess,
  effectivePermissions,
  inviteToStore,
  listMembers,
  listStoreInvites,
  revokeInvite,
  setMemberPermission,
  listStores,
  removeMember,
  transferOwnership,
  updateMember,
  type Principal,
  type StorePermission,
} from '../../src';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

const admin: Principal = { userId: 'user_admin_01', role: 'admin' };
const owner: Principal = { userId: 'user_owner_01', role: 'member' };
const leader: Principal = { userId: 'user_leadr_01', role: 'member' };
const seller: Principal = { userId: 'user_sellr_01', role: 'member' };
const outsider: Principal = { userId: 'user_outsd_01', role: 'member' };

const STORE = 'store_aaa_001';
const OTHER = 'store_bbb_001';

async function harness(): Promise<Database> {
  const test = await createTestDatabase();
  cleanup.push(() => test.drop());
  await migrateDatabase(test.connection);
  const handle = createDatabase(test.connection, { max: 4 });
  cleanup.push(() => handle.close());
  const db = handle.db;

  await db.insert(users).values([
    { id: admin.userId, name: 'Admin', email: 'admin@example.test', role: 'admin' },
    { id: owner.userId, name: 'Olivia Owner', email: 'owner@example.test', role: 'member' },
    { id: leader.userId, name: 'Liam Leader', email: 'leader@example.test', role: 'member' },
    { id: seller.userId, name: 'Sam Seller', email: 'seller@example.test', role: 'member' },
    { id: outsider.userId, name: 'Oscar Outsider', email: 'outsider@example.test', role: 'member' },
  ]);
  await db.insert(stores).values([
    { id: STORE, name: 'Alpha Store', domain: 'alpha.myshopify.com' },
    { id: OTHER, name: 'Beta Store', domain: 'beta.myshopify.com' },
  ]);
  await db.insert(storeMembers).values([
    { id: 'sm_owner', storeId: STORE, userId: owner.userId, role: 'owner', permissions: [...ROLE_PRESETS.owner] },
    { id: 'sm_leadr', storeId: STORE, userId: leader.userId, role: 'co_leader', permissions: [...ROLE_PRESETS.co_leader] },
    { id: 'sm_sellr', storeId: STORE, userId: seller.userId, role: 'seller', permissions: [...ROLE_PRESETS.seller] },
    { id: 'sm_other', storeId: OTHER, userId: outsider.userId, role: 'owner', permissions: [...ROLE_PRESETS.owner] },
  ]);
  return db;
}

async function expectAuthError(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toBeInstanceOf(AuthError);
  await expect(promise).rejects.toMatchObject({ code });
}

async function memberRow(db: Database, userId: string, storeId = STORE) {
  const rows = await db.select().from(storeMembers).where(eq(storeMembers.userId, userId));
  return rows.find((r) => r.storeId === storeId) ?? null;
}

async function auditActions(db: Database) {
  const rows = await db.select({ action: auditLog.action, storeId: auditLog.storeId }).from(auditLog);
  return rows.map((r) => r.action);
}

describe('effectivePermissions (ADR 0002 matrix)', () => {
  it('gives each role exactly its preset when nothing was toggled', () => {
    for (const [role, preset] of Object.entries(ROLE_PRESETS)) {
      const granted = effectivePermissions({ userId: 'u', role: 'member' }, { role: role as keyof typeof ROLE_PRESETS, permissions: preset });
      expect(granted, role).toEqual(STORE_PERMISSIONS.filter((p) => preset.includes(p)));
    }
  });

  it('never lets admin push, publish or read store settings by default', () => {
    const granted = effectivePermissions({ userId: 'a', role: 'admin' }, null);
    expect(granted).toEqual([...ADMIN_STORE_PERMISSIONS]);
    for (const permission of ['product.push', 'product.publish', 'store.settings'] as const) {
      expect(granted).not.toContain(permission);
    }
  });

  it('adds admin powers on top of an explicit membership instead of replacing it', () => {
    const granted = effectivePermissions({ userId: 'a', role: 'admin' }, { role: 'seller_support', permissions: ['store.view', 'product.push'] });
    expect(granted).toContain('product.push');
    expect(granted).toContain('store.members');
    expect(granted).not.toContain('product.publish');
  });

  it('gives a non-member nothing', () => {
    expect(effectivePermissions({ userId: 'm', role: 'member' }, null)).toEqual([]);
  });
});

describe('can()', () => {
  it('reads the membership of exactly the store asked about', async () => {
    const db = await harness();
    expect(await can(db, seller, 'product.edit', { storeId: STORE })).toBe(true);
    expect(await can(db, seller, 'product.push', { storeId: STORE })).toBe(false);
    expect(await can(db, seller, 'store.view', { storeId: OTHER })).toBe(false);
    expect(await can(db, owner, 'product.publish', { storeId: STORE })).toBe(true);
    expect(await can(db, admin, 'store.members', { storeId: STORE })).toBe(true);
    expect(await can(db, admin, 'product.push', { storeId: STORE })).toBe(false);
  });

  it('fails closed on unknown permissions, empty scopes and corrupt rows', async () => {
    const db = await harness();
    expect(await can(db, owner, 'store.delete' as StorePermission, { storeId: STORE })).toBe(false);
    expect(await can(db, owner, 'store.view', { storeId: '' })).toBe(false);
    await db.update(storeMembers).set({ role: 'superuser' }).where(eq(storeMembers.id, 'sm_sellr'));
    expect(await can(db, seller, 'store.view', { storeId: STORE })).toBe(false);
  });
});

describe('listing stores and members', () => {
  it('shows members only their stores and admins every store', async () => {
    const db = await harness();
    expect((await listStores(db, seller)).map((s) => s.id)).toEqual([STORE]);
    expect((await listStores(db, outsider)).map((s) => s.id)).toEqual([OTHER]);
    const all = await listStores(db, admin);
    expect(all.map((s) => s.name)).toEqual(['Alpha Store', 'Beta Store']);
    expect(all[0]).toMatchObject({ memberCount: 3, owner: { userId: owner.userId }, myRole: null });
  });

  it('answers NOT_FOUND for a store the viewer cannot see, so ids cannot be probed', async () => {
    const db = await harness();
    await expectAuthError(listMembers(db, outsider, STORE), 'NOT_FOUND');
    await expectAuthError(listMembers(db, outsider, 'store_missing'), 'NOT_FOUND');
    const view = await listMembers(db, seller, STORE);
    expect(view.members.map((m) => m.userId)).toEqual([owner.userId, leader.userId, seller.userId]);
    expect(view.viewer).toMatchObject({ role: 'seller', isAdmin: false });
  });
});

describe('createStore', () => {
  it('lets only an admin register a store, with exactly one owner, and audits it', async () => {
    const db = await harness();
    await expectAuthError(createStore(db, owner, { name: 'Gamma', domain: 'gamma.myshopify.com', ownerUserId: owner.userId }), 'FORBIDDEN');
    const { storeId } = await createStore(db, admin, { name: ' Gamma ', domain: 'Gamma.myshopify.com', ownerUserId: seller.userId });
    expect(await memberRow(db, seller.userId, storeId)).toMatchObject({ role: 'owner', grantedBy: admin.userId });
    expect(await auditActions(db)).toContain('store.create');
    await expectAuthError(createStore(db, admin, { name: 'Dup', domain: 'gamma.myshopify.com', ownerUserId: seller.userId }), 'STORE_EXISTS');
    await expectAuthError(createStore(db, admin, { name: 'Bad', domain: 'gamma.example.com', ownerUserId: seller.userId }), 'INVALID_INPUT');
  });
});

describe('member changes (no escalation)', () => {
  it('adds an existing account with its preset and refuses duplicates', async () => {
    const db = await harness();
    await addMember(db, leader, STORE, { email: 'Outsider@Example.test', role: 'designer' });
    expect(await memberRow(db, outsider.userId)).toMatchObject({ role: 'designer', permissions: ['store.view', 'design.upload'], grantedBy: leader.userId });
    await expectAuthError(addMember(db, leader, STORE, { email: 'outsider@example.test', role: 'viewer' }), 'ALREADY_MEMBER');
    await expectAuthError(addMember(db, leader, STORE, { email: 'nobody@example.test', role: 'viewer' }), 'NOT_FOUND');
    expect(await auditActions(db)).toEqual(['store.member.add']);
  });

  it('refuses member changes from people without store.members', async () => {
    const db = await harness();
    await expectAuthError(addMember(db, seller, STORE, { email: 'outsider@example.test', role: 'viewer' }), 'FORBIDDEN');
    await expectAuthError(updateMember(db, outsider, STORE, seller.userId, { role: 'viewer', permissions: ['store.view'] }), 'FORBIDDEN');
    await expectAuthError(removeMember(db, seller, STORE, leader.userId), 'FORBIDDEN');
  });

  it('lets only the owner grant publish, and nobody grant what they do not hold', async () => {
    const db = await harness();
    const publish = { role: 'seller_support' as const, permissions: ['store.view', 'product.publish'] as StorePermission[] };
    await expectAuthError(updateMember(db, leader, STORE, seller.userId, publish), 'FORBIDDEN');
    await expectAuthError(updateMember(db, admin, STORE, seller.userId, publish), 'FORBIDDEN');
    await expectAuthError(
      updateMember(db, leader, STORE, seller.userId, { role: 'seller', permissions: ['store.view', 'store.settings'] }),
      'FORBIDDEN',
    );
    await expectAuthError(
      updateMember(db, admin, STORE, seller.userId, { role: 'seller', permissions: ['store.view', 'product.push'] }),
      'FORBIDDEN',
    );
    await updateMember(db, owner, STORE, seller.userId, publish);
    expect(await memberRow(db, seller.userId)).toMatchObject({ role: 'seller_support', permissions: ['store.view', 'product.publish'] });
  });

  it('lets a co-leader promote within what it holds and records before/after in the audit log', async () => {
    const db = await harness();
    await updateMember(db, leader, STORE, seller.userId, {
      role: 'seller_support',
      permissions: ['store.view', 'analysis.run', 'product.edit', 'content.generate', 'product.push'],
    });
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, 'store.member.update'));
    expect(entry).toMatchObject({ actorUserId: leader.userId, storeId: STORE, targetId: seller.userId });
    expect(entry!.data).toMatchObject({ added: ['product.push'], removed: [], before: { role: 'seller' }, after: { role: 'seller_support' } });
  });

  it('does not let a co-leader revoke publish it could never have granted', async () => {
    const db = await harness();
    await updateMember(db, owner, STORE, seller.userId, { role: 'seller_support', permissions: ['store.view', 'product.publish'] });
    await expectAuthError(updateMember(db, leader, STORE, seller.userId, { role: 'seller', permissions: ['store.view'] }), 'FORBIDDEN');
    await expectAuthError(removeMember(db, leader, STORE, seller.userId), 'FORBIDDEN');
    await updateMember(db, admin, STORE, seller.userId, { role: 'seller', permissions: ['store.view'] });
  });

  it('keeps the owner row out of reach of updates, removals and promotions', async () => {
    const db = await harness();
    await expectAuthError(updateMember(db, admin, STORE, owner.userId, { role: 'viewer', permissions: ['store.view'] }), 'LAST_OWNER');
    await expectAuthError(removeMember(db, admin, STORE, owner.userId), 'LAST_OWNER');
    await expectAuthError(removeMember(db, owner, STORE, owner.userId), 'LAST_OWNER');
    await expectAuthError(updateMember(db, owner, STORE, seller.userId, { role: 'owner', permissions: ['store.view'] }), 'FORBIDDEN');
    await expectAuthError(addMember(db, owner, STORE, { email: 'outsider@example.test', role: 'owner' }), 'FORBIDDEN');
  });

  it('lets anyone leave a store and lets managers remove members', async () => {
    const db = await harness();
    await removeMember(db, seller, STORE, seller.userId);
    expect(await memberRow(db, seller.userId)).toBeNull();
    await removeMember(db, owner, STORE, leader.userId);
    expect(await memberRow(db, leader.userId)).toBeNull();
    expect(await auditActions(db)).toEqual(['store.member.remove', 'store.member.remove']);
  });

  it('rejects unknown roles and permissions', async () => {
    const db = await harness();
    await expectAuthError(updateMember(db, owner, STORE, seller.userId, { role: 'superuser' as 'viewer', permissions: [] }), 'INVALID_INPUT');
    await expectAuthError(
      updateMember(db, owner, STORE, seller.userId, { role: 'viewer', permissions: ['store.delete' as StorePermission] }),
      'INVALID_INPUT',
    );
  });
});

describe('transferOwnership', () => {
  it('moves ownership to an existing member and keeps the old owner as co-leader', async () => {
    const db = await harness();
    await transferOwnership(db, owner, STORE, seller.userId);
    expect(await memberRow(db, seller.userId)).toMatchObject({ role: 'owner', permissions: [...ROLE_PRESETS.owner] });
    expect(await memberRow(db, owner.userId)).toMatchObject({ role: 'co_leader', permissions: [...ROLE_PRESETS.co_leader] });
    expect(await can(db, owner, 'product.publish', { storeId: STORE })).toBe(false);
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, 'store.owner.transfer'));
    expect(entry).toMatchObject({ actorUserId: owner.userId, storeId: STORE, targetId: seller.userId });
    expect(entry!.data).toMatchObject({ previousOwnerUserId: owner.userId, newOwnerUserId: seller.userId, newOwnerPreviousRole: 'seller' });
  });

  it('allows only the owner or an admin, and only to a current member', async () => {
    const db = await harness();
    await expectAuthError(transferOwnership(db, leader, STORE, leader.userId), 'FORBIDDEN');
    await expectAuthError(transferOwnership(db, owner, STORE, outsider.userId), 'NOT_FOUND');
    await expectAuthError(transferOwnership(db, owner, STORE, owner.userId), 'INVALID_INPUT');
    await expectAuthError(transferOwnership(db, owner, 'store_missing', leader.userId), 'NOT_FOUND');
    await transferOwnership(db, admin, STORE, leader.userId);
    expect(await memberRow(db, leader.userId)).toMatchObject({ role: 'owner' });
  });

  it('keeps exactly one owner when two transfers race', async () => {
    const db = await harness();
    const results = await Promise.allSettled([
      transferOwnership(db, owner, STORE, leader.userId),
      transferOwnership(db, owner, STORE, seller.userId),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const owners = (await db.select().from(storeMembers).where(eq(storeMembers.storeId, STORE))).filter((r) => r.role === 'owner');
    expect(owners).toHaveLength(1);
  });

  it('is backed by a database constraint that refuses a second owner row', async () => {
    const db = await harness();
    await expect(db.update(storeMembers).set({ role: 'owner' }).where(eq(storeMembers.id, 'sm_leadr'))).rejects.toMatchObject({
      cause: { code: '23505' },
    });
  });
});

describe('store invites end to end', () => {
  it('turns an accepted store invite into a real membership', async () => {
    const db = await harness();
    const deps = { db, storeAccess: createStoreAccess(db) };
    const invite = await createInvite(deps, leader, {
      email: 'newcomer@example.test',
      store: { storeId: STORE, role: 'designer', permissions: ['store.view'] },
    });
    const { userId } = await acceptInvite(deps, { token: invite.token, name: 'New Comer', password: 'long-enough-password-1' });
    expect(await memberRow(db, userId)).toMatchObject({ role: 'designer', permissions: ['store.view'], grantedBy: leader.userId });
    expect((await listMembers(db, leader, STORE)).members.map((m) => m.email)).toContain('newcomer@example.test');
  });
});

describe('what the members screen offers (mirrors the write checks)', () => {
  const viewers = { admin, owner, leader, seller, outsider };

  it('offers exactly the toggles, edits, removals and transfers the write functions accept', async () => {
    const db = await harness();
    for (const [label, viewer] of Object.entries(viewers)) {
      if (viewer === outsider) continue;
      const view = await listMembers(db, viewer, STORE);
      for (const row of view.members) {
        for (const permission of STORE_PERMISSIONS) {
          const next = row.permissions.includes(permission)
            ? row.permissions.filter((p) => p !== permission)
            : [...row.permissions, permission];
          const attempt = updateMember(db, viewer, STORE, row.userId, { role: row.role === 'owner' ? 'co_leader' : row.role, permissions: next });
          const accepted = await attempt.then(
            async () => {
              // Undo through the owner so every probe starts from the same rows.
              await db.update(storeMembers).set({ role: row.role, permissions: row.permissions }).where(eq(storeMembers.userId, row.userId));
              return true;
            },
            () => false,
          );
          expect(accepted, `${label} toggles ${permission} on ${row.email}`).toBe(row.can.toggle.includes(permission));
        }
        const isSelfBelowOwner = row.userId === viewer.userId && view.viewer.role !== 'owner' && !view.viewer.isAdmin;
        expect(row.can.edit, `${label} edits ${row.email}`).toBe(view.viewer.canManage && row.role !== 'owner' && !isSelfBelowOwner);
        expect(row.can.makeOwner, `${label} transfers to ${row.email}`).toBe(
          row.role !== 'owner' && (view.viewer.role === 'owner' || view.viewer.isAdmin),
        );
      }
    }
  });

  it('offers removal only where removeMember would succeed', async () => {
    const db = await harness();
    const view = await listMembers(db, leader, STORE);
    expect(Object.fromEntries(view.members.map((m) => [m.email, m.can.remove]))).toEqual({
      'owner@example.test': false,
      'leader@example.test': true,
      'seller@example.test': true,
    });
    expect((await listMembers(db, seller, STORE)).members.map((m) => m.can.remove)).toEqual([false, false, true]);
  });

  it('lists invite roles the viewer can fully grant, and none for read-only members', async () => {
    const db = await harness();
    expect((await listMembers(db, owner, STORE)).viewer.inviteRoles).toEqual(['co_leader', 'seller_support', 'seller', 'designer', 'viewer']);
    expect((await listMembers(db, leader, STORE)).viewer.inviteRoles).toEqual(['co_leader', 'seller_support', 'seller', 'designer', 'viewer']);
    expect((await listMembers(db, admin, STORE)).viewer.inviteRoles).toEqual(['seller_support', 'seller', 'viewer']);
    expect((await listMembers(db, seller, STORE)).viewer).toMatchObject({ canManage: false, inviteRoles: [] });
  });
});

describe('inviting from the members screen', () => {
  it('adds an existing account at once and sends everyone else an invite link', async () => {
    const db = await harness();
    const deps = { db, storeAccess: createStoreAccess(db) };
    const added = await inviteToStore(deps, leader, STORE, { email: 'Outsider@example.test', role: 'viewer' });
    expect(added).toMatchObject({ kind: 'added', userId: outsider.userId });
    expect(await memberRow(db, outsider.userId)).toMatchObject({ role: 'viewer', permissions: ['store.view'] });

    const invited = await inviteToStore(deps, leader, STORE, { email: 'new@example.test', role: 'seller' });
    expect(invited.kind).toBe('invited');
    const pending = await listStoreInvites(deps, leader, STORE);
    expect(pending).toMatchObject([{ email: 'new@example.test', role: 'seller', permissions: [...ROLE_PRESETS.seller] }]);
    await expectAuthError(inviteToStore(deps, seller, STORE, { email: 'other@example.test', role: 'viewer' }), 'FORBIDDEN');
    await expectAuthError(inviteToStore(deps, leader, STORE, { email: 'x@example.test', role: 'owner' }), 'FORBIDDEN');
  });

  it('shows pending invites only to member managers and hides revoked ones', async () => {
    const db = await harness();
    const deps = { db, storeAccess: createStoreAccess(db) };
    const result = await inviteToStore(deps, owner, STORE, { email: 'pending@example.test', role: 'designer' });
    if (result.kind !== 'invited') throw new Error('expected an invite');
    expect(await listStoreInvites(deps, admin, STORE)).toHaveLength(1);
    expect(await listStoreInvites(deps, owner, OTHER).catch((e: AuthError) => e.code)).toBe('FORBIDDEN');
    await expectAuthError(listStoreInvites(deps, seller, STORE), 'FORBIDDEN');
    await revokeInvite(deps, leader, result.invite.id);
    expect(await listStoreInvites(deps, owner, STORE)).toEqual([]);
  });
});

describe('toggling one permission', () => {
  it('switches a single permission and audits it like any other change', async () => {
    const db = await harness();
    await setMemberPermission(db, owner, STORE, seller.userId, 'product.push', true);
    expect((await memberRow(db, seller.userId))?.permissions).toContain('product.push');
    await setMemberPermission(db, owner, STORE, seller.userId, 'product.push', false);
    expect((await memberRow(db, seller.userId))?.permissions).not.toContain('product.push');
    await expectAuthError(setMemberPermission(db, leader, STORE, seller.userId, 'product.publish', true), 'FORBIDDEN');
    await expectAuthError(setMemberPermission(db, owner, STORE, seller.userId, 'nope' as never, true), 'INVALID_INPUT');
  });

  it('keeps both of two concurrent toggles on the same member', async () => {
    const db = await harness();
    await Promise.all([
      setMemberPermission(db, owner, STORE, seller.userId, 'product.push', true),
      setMemberPermission(db, owner, STORE, seller.userId, 'product.publish', true),
    ]);
    expect((await memberRow(db, seller.userId))?.permissions).toEqual(expect.arrayContaining(['product.push', 'product.publish']));
  });
});
