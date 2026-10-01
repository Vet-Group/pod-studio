import { afterEach, describe, expect, it } from 'vitest';
import { auditLog, createDatabase, eq, invites, migrateDatabase, sql, stores, users, type Database } from '@pod-studio/db';
import { createTestDatabase } from '../../../../tests/support/db';
import {
  AuthError,
  INVITE_TTL_MS,
  acceptInvite,
  createInvite,
  findInvite,
  hashInviteToken,
  revokeInvite,
  type Principal,
  type StoreAccess,
  type StoreGrant,
  type StoreMembership,
} from '../../src/auth';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

interface Harness {
  db: Database;
  admin: Principal;
  member: Principal;
  memberships: Map<string, StoreMembership>;
  grants: StoreGrant[];
  storeAccess: StoreAccess;
  clock: { now: Date };
  deps: { db: Database; storeAccess: StoreAccess; now: () => Date };
}

async function harness(): Promise<Harness> {
  const test = await createTestDatabase();
  cleanup.push(() => test.drop());
  await migrateDatabase(test.connection);
  const handle = createDatabase(test.connection, { max: 4 });
  cleanup.push(() => handle.close());
  const db = handle.db;

  await db.insert(users).values([
    { id: 'user_admin_01', name: 'Admin', email: 'admin@example.test', role: 'admin' },
    { id: 'user_membr_01', name: 'Leader', email: 'leader@example.test', role: 'member' },
  ]);
  await db.insert(stores).values([
    { id: 'store_aaa_001', name: 'Store A', domain: 'a.myshopify.com' },
    { id: 'store_bbb_001', name: 'Store B', domain: 'b.myshopify.com' },
  ]);

  const memberships = new Map<string, StoreMembership>();
  const grants: StoreGrant[] = [];
  const storeAccess: StoreAccess = {
    membership: async (userId, storeId) => memberships.get(`${userId}:${storeId}`) ?? null,
    grant: async (_tx, grant) => {
      grants.push(grant);
    },
  };
  const clock = { now: new Date('2026-10-01T00:00:00Z') };
  return {
    db,
    admin: { userId: 'user_admin_01', role: 'admin' },
    member: { userId: 'user_membr_01', role: 'member' },
    memberships,
    grants,
    storeAccess,
    clock,
    deps: { db, storeAccess, now: () => clock.now },
  };
}

async function expectAuthError(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toBeInstanceOf(AuthError);
  await expect(promise).rejects.toMatchObject({ code });
}

const newcomer = { name: 'New Hire', password: 'long-enough-password-1' };

describe('invite tokens', () => {
  it('stores only the SHA-256 hash of the token, never the token itself', async () => {
    const h = await harness();
    const { id, token } = await createInvite(h.deps, h.admin, { email: '  New.Person@Example.test ' });

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [row] = await h.db.select().from(invites).where(eq(invites.id, id));
    expect(row?.tokenHash).toBe(hashInviteToken(token));
    expect(row?.tokenHash).not.toBe(token);
    expect(row?.email).toBe('new.person@example.test');

    const leaks = await h.db.execute<{ n: number }>(sql`
      select (select count(*)::int from invites i where row_to_json(i)::text like ${'%' + token + '%'})
           + (select count(*)::int from audit_log a where row_to_json(a)::text like ${'%' + token + '%'}) as n`);
    expect(leaks[0]?.n).toBe(0);
  });

  it('expires seven days after creation', async () => {
    const h = await harness();
    const { token, expiresAt } = await createInvite(h.deps, h.admin, { email: 'late@example.test' });
    expect(expiresAt.getTime() - h.clock.now.getTime()).toBe(INVITE_TTL_MS);

    h.clock.now = new Date(expiresAt.getTime());
    expect((await findInvite(h.db, token, h.clock.now)).status).toBe('expired');
    await expectAuthError(acceptInvite(h.deps, { token, ...newcomer }), 'INVITE_EXPIRED');
    expect(await h.db.$count(users, eq(users.email, 'late@example.test'))).toBe(0);
  });

  it('can still be accepted just before it expires', async () => {
    const h = await harness();
    const { token, expiresAt } = await createInvite(h.deps, h.admin, { email: 'ontime@example.test' });
    h.clock.now = new Date(expiresAt.getTime() - 1000);
    expect((await findInvite(h.db, token, h.clock.now)).status).toBe('valid');
    await expect(acceptInvite(h.deps, { token, ...newcomer })).resolves.toMatchObject({ email: 'ontime@example.test' });
  });

  it('rejects a token that was already accepted (replay)', async () => {
    const h = await harness();
    const { token } = await createInvite(h.deps, h.admin, { email: 'once@example.test' });
    const first = await acceptInvite(h.deps, { token, ...newcomer });

    await expectAuthError(acceptInvite(h.deps, { token, ...newcomer, password: 'another-password-2' }), 'INVITE_USED');
    expect((await findInvite(h.db, token, h.clock.now)).status).toBe('used');
    expect(await h.db.$count(users, eq(users.email, 'once@example.test'))).toBe(1);
    const [row] = await h.db.select().from(invites).where(eq(invites.acceptedBy, first.userId));
    expect(row?.acceptedAt).toBeInstanceOf(Date);
  });

  it('lets only one of two concurrent accepts win', async () => {
    const h = await harness();
    const { token } = await createInvite(h.deps, h.admin, { email: 'race@example.test' });
    const results = await Promise.allSettled([
      acceptInvite(h.deps, { token, ...newcomer }),
      acceptInvite(h.deps, { token, ...newcomer }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(rejected?.reason).toMatchObject({ code: 'INVITE_USED' });
    expect(await h.db.$count(users, eq(users.email, 'race@example.test'))).toBe(1);
  });

  it('rejects a revoked token', async () => {
    const h = await harness();
    const { id, token } = await createInvite(h.deps, h.admin, { email: 'revoked@example.test' });
    await revokeInvite(h.deps, h.admin, id);

    expect((await findInvite(h.db, token, h.clock.now)).status).toBe('revoked');
    await expectAuthError(acceptInvite(h.deps, { token, ...newcomer }), 'INVITE_REVOKED');
    await expectAuthError(revokeInvite(h.deps, h.admin, id), 'INVITE_REVOKED');
    expect(await h.db.$count(users, eq(users.email, 'revoked@example.test'))).toBe(0);
  });

  it('rejects unknown tokens', async () => {
    const h = await harness();
    expect((await findInvite(h.db, 'not-a-real-token', h.clock.now)).status).toBe('not_found');
    await expectAuthError(acceptInvite(h.deps, { token: 'not-a-real-token', ...newcomer }), 'INVITE_NOT_FOUND');
  });

  it('creates the account with the invited email and a working password, and audits every step', async () => {
    const h = await harness();
    const { id, token } = await createInvite(h.deps, h.admin, { email: 'audited@example.test' });
    const { userId } = await acceptInvite(h.deps, { token, name: '  Lan Anh ', password: newcomer.password });

    const [user] = await h.db.select().from(users).where(eq(users.id, userId));
    expect(user).toMatchObject({ name: 'Lan Anh', email: 'audited@example.test', role: 'member', mustChangePassword: false });

    const log = await h.db.select().from(auditLog).where(eq(auditLog.targetId, id)).orderBy(auditLog.createdAt);
    expect(log.map((e) => [e.action, e.actorUserId])).toEqual([
      ['invite.create', 'user_admin_01'],
      ['invite.accept', userId],
    ]);
  });

  it('refuses an account invite for an email that already has an account', async () => {
    const h = await harness();
    await expectAuthError(createInvite(h.deps, h.admin, { email: 'LEADER@example.test' }), 'ACCOUNT_EXISTS');
  });

  it('refuses to accept an invite when the email got an account in the meantime', async () => {
    const h = await harness();
    const { token } = await createInvite(h.deps, h.admin, { email: 'twice@example.test' });
    await h.db.insert(users).values({ id: 'user_twice_01', name: 'Twice', email: 'twice@example.test' });
    await expectAuthError(acceptInvite(h.deps, { token, ...newcomer }), 'ACCOUNT_EXISTS');
    expect((await findInvite(h.db, token, h.clock.now)).status).toBe('valid');
  });

  it('refuses weak passwords and blank names without using up the invite', async () => {
    const h = await harness();
    const { token } = await createInvite(h.deps, h.admin, { email: 'weak@example.test' });
    await expectAuthError(acceptInvite(h.deps, { token, name: 'Weak', password: 'short' }), 'WEAK_PASSWORD');
    await expectAuthError(acceptInvite(h.deps, { token, name: '   ', password: newcomer.password }), 'INVALID_INPUT');
    expect((await findInvite(h.db, token, h.clock.now)).status).toBe('valid');
  });
});

describe('invite permissions (no escalation through invites)', () => {
  it('only lets an admin create an invite without a store', async () => {
    const h = await harness();
    await expectAuthError(createInvite(h.deps, h.member, { email: 'x@example.test' }), 'FORBIDDEN');
  });

  it('never lets a non-admin hand out the global admin role', async () => {
    const h = await harness();
    h.memberships.set('user_membr_01:store_aaa_001', { role: 'owner', permissions: ['store.view', 'store.members'] });
    await expectAuthError(
      createInvite(h.deps, h.member, {
        email: 'x@example.test',
        globalRole: 'admin',
        store: { storeId: 'store_aaa_001', role: 'viewer', permissions: ['store.view'] },
      }),
      'FORBIDDEN',
    );
    await expect(createInvite(h.deps, h.admin, { email: 'second-admin@example.test', globalRole: 'admin' })).resolves.toBeTruthy();
  });

  it('requires store.members in exactly the store the invite is for', async () => {
    const h = await harness();
    h.memberships.set('user_membr_01:store_aaa_001', {
      role: 'co_leader',
      permissions: ['store.view', 'product.edit', 'store.members'],
    });
    h.memberships.set('user_membr_01:store_bbb_001', { role: 'seller', permissions: ['store.view', 'product.edit'] });
    const store = (storeId: string) => ({ storeId, role: 'seller' as const, permissions: ['store.view' as const] });

    await expectAuthError(createInvite(h.deps, h.member, { email: 'x@example.test', store: store('store_bbb_001') }), 'FORBIDDEN');
    await expect(createInvite(h.deps, h.member, { email: 'x@example.test', store: store('store_aaa_001') })).resolves.toBeTruthy();
    // Admins invite into any store (ADR 0002 "admins (any scope)").
    await expect(createInvite(h.deps, h.admin, { email: 'y@example.test', store: store('store_bbb_001') })).resolves.toBeTruthy();
  });

  it('refuses to grant a permission the inviter does not hold', async () => {
    const h = await harness();
    h.memberships.set('user_membr_01:store_aaa_001', {
      role: 'co_leader',
      permissions: ['store.view', 'product.edit', 'store.members'],
    });
    await expectAuthError(
      createInvite(h.deps, h.member, {
        email: 'x@example.test',
        store: { storeId: 'store_aaa_001', role: 'seller', permissions: ['store.view', 'product.push'] },
      }),
      'FORBIDDEN',
    );
  });

  it('lets only the owner grant product.publish, and nobody invite a second owner', async () => {
    const h = await harness();
    const all = ['store.view', 'product.edit', 'product.push', 'product.publish', 'store.members'] as const;
    h.memberships.set('user_membr_01:store_aaa_001', { role: 'co_leader', permissions: [...all] });
    const publish = { storeId: 'store_aaa_001', role: 'seller_support' as const, permissions: ['store.view' as const, 'product.publish' as const] };
    await expectAuthError(createInvite(h.deps, h.member, { email: 'x@example.test', store: publish }), 'FORBIDDEN');

    // Not even an admin: product.publish is granted only by the store owner (ADR 0002 rule 2).
    await expectAuthError(createInvite(h.deps, h.admin, { email: 'x@example.test', store: publish }), 'FORBIDDEN');

    h.memberships.set('user_membr_01:store_aaa_001', { role: 'owner', permissions: [...all] });
    await expect(createInvite(h.deps, h.member, { email: 'x@example.test', store: publish })).resolves.toBeTruthy();
    await expectAuthError(
      createInvite(h.deps, h.member, {
        email: 'y@example.test',
        store: { storeId: 'store_aaa_001', role: 'owner', permissions: ['store.view'] },
      }),
      'FORBIDDEN',
    );
  });

  it('never lets anyone invite themselves (no self-granted store access)', async () => {
    const h = await harness();
    const store = { storeId: 'store_aaa_001', role: 'seller' as const, permissions: ['store.view' as const, 'product.push' as const] };
    await expectAuthError(createInvite(h.deps, h.admin, { email: 'Admin@Example.test', store }), 'FORBIDDEN');
  });

  it('rejects unknown store roles and permissions', async () => {
    const h = await harness();
    const bad = (role: string, permissions: string[]) =>
      createInvite(h.deps, h.admin, { email: 'x@example.test', store: { storeId: 'store_aaa_001', role, permissions } as never });
    await expectAuthError(bad('superuser', ['store.view']), 'INVALID_INPUT');
    await expectAuthError(bad('seller', ['store.delete']), 'INVALID_INPUT');
  });

  it('refuses store invites when store access cannot be granted yet', async () => {
    const h = await harness();
    const store = { storeId: 'store_aaa_001', role: 'seller' as const, permissions: ['store.view' as const] };
    await expectAuthError(createInvite({ db: h.db, now: h.deps.now }, h.admin, { email: 'x@example.test', store }), 'NOT_SUPPORTED');
  });

  it('grants the invited store access when the invite is accepted', async () => {
    const h = await harness();
    h.memberships.set('user_membr_01:store_aaa_001', { role: 'owner', permissions: ['store.view', 'product.edit', 'store.members'] });
    const { token } = await createInvite(h.deps, h.member, {
      email: 'seller@example.test',
      store: { storeId: 'store_aaa_001', role: 'seller', permissions: ['store.view', 'product.edit', 'store.view'] },
    });
    const { userId } = await acceptInvite(h.deps, { token, ...newcomer });
    expect(h.grants).toEqual([{ storeId: 'store_aaa_001', userId, role: 'seller', permissions: ['store.view', 'product.edit'] }]);
  });

  it('only lets the inviter, a store manager or an admin revoke an invite', async () => {
    const h = await harness();
    const { id } = await createInvite(h.deps, h.admin, { email: 'keep@example.test' });
    await expectAuthError(revokeInvite(h.deps, h.member, id), 'FORBIDDEN');
    await expect(revokeInvite(h.deps, h.admin, id)).resolves.toBeUndefined();
  });
});
