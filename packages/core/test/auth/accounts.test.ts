import { afterEach, describe, expect, it } from 'vitest';
import { verifyPassword } from 'better-auth/crypto';
import { accounts, auditLog, createDatabase, eq, migrateDatabase, sessions, users, type Database } from '@pod-studio/db';
import { createTestDatabase } from '../../../../tests/support/db';
import { AuthError, changePassword, createUserWithTemporaryPassword, hashPassword, type Principal } from '../../src/auth';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

const admin: Principal = { userId: 'user_admin_01', role: 'admin' };

async function database(): Promise<Database> {
  const test = await createTestDatabase();
  cleanup.push(() => test.drop());
  await migrateDatabase(test.connection);
  const handle = createDatabase(test.connection, { max: 4 });
  cleanup.push(() => handle.close());
  await handle.db.insert(users).values({ id: admin.userId, name: 'Admin', email: 'admin@example.test', role: 'admin' });
  return handle.db;
}

async function storedHash(db: Database, userId: string) {
  const [row] = await db.select({ password: accounts.password }).from(accounts).where(eq(accounts.userId, userId));
  return row!.password!;
}

async function addSession(db: Database, userId: string, id: string) {
  await db.insert(sessions).values({ id, token: `token-${id}`, userId, expiresAt: new Date(Date.now() + 3_600_000) });
}

describe('temporary passwords', () => {
  it('lets only an admin create an account, flagged to change its password', async () => {
    const db = await database();
    await expect(
      createUserWithTemporaryPassword(db, { userId: admin.userId, role: 'member' }, { email: 'x@example.test', name: 'X' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const created = await createUserWithTemporaryPassword(db, admin, { email: ' Staff@Example.test ', name: 'Staff Member' });
    expect(created.email).toBe('staff@example.test');
    expect(created.temporaryPassword.length).toBeGreaterThanOrEqual(16);

    const [user] = await db.select().from(users).where(eq(users.id, created.userId));
    expect(user).toMatchObject({ mustChangePassword: true, role: 'member' });
    const hash = await storedHash(db, created.userId);
    expect(hash).not.toContain(created.temporaryPassword);
    expect(await verifyPassword({ hash, password: created.temporaryPassword })).toBe(true);

    const [entry] = await db.select().from(auditLog).where(eq(auditLog.targetId, created.userId));
    expect(entry).toMatchObject({ action: 'user.create', actorUserId: admin.userId });
    expect(JSON.stringify(entry!.data)).not.toContain(created.temporaryPassword);
  });

  it('refuses a second account for the same email', async () => {
    const db = await database();
    await expect(createUserWithTemporaryPassword(db, admin, { email: 'ADMIN@example.test', name: 'Dup' })).rejects.toMatchObject({
      code: 'ACCOUNT_EXISTS',
    });
  });
});

describe('changePassword', () => {
  it('replaces the password, clears the flag, keeps this session and signs out the others', async () => {
    const db = await database();
    const { userId, temporaryPassword } = await createUserWithTemporaryPassword(db, admin, { email: 's@example.test', name: 'S' });
    await addSession(db, userId, 'sess_current_1');
    await addSession(db, userId, 'sess_other_001');

    await changePassword(db, { userId, currentPassword: temporaryPassword, newPassword: 'new-password-123', keepSessionId: 'sess_current_1' });

    const hash = await storedHash(db, userId);
    expect(await verifyPassword({ hash, password: 'new-password-123' })).toBe(true);
    expect(await verifyPassword({ hash, password: temporaryPassword })).toBe(false);
    const [user] = await db.select({ must: users.mustChangePassword }).from(users).where(eq(users.id, userId));
    expect(user?.must).toBe(false);
    expect((await db.select({ id: sessions.id }).from(sessions)).map((s) => s.id)).toEqual(['sess_current_1']);

    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, 'auth.password.change'));
    expect(entry).toMatchObject({ actorUserId: userId, targetId: userId, data: { forced: true, revokedSessions: 1 } });
  });

  it('rejects a wrong current password without changing anything', async () => {
    const db = await database();
    const { userId, temporaryPassword } = await createUserWithTemporaryPassword(db, admin, { email: 'w@example.test', name: 'W' });
    const before = await storedHash(db, userId);

    const attempt = changePassword(db, { userId, currentPassword: 'wrong-password-1', newPassword: 'new-password-123' });
    await expect(attempt).rejects.toBeInstanceOf(AuthError);
    await expect(attempt).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await storedHash(db, userId)).toBe(before);
    const [user] = await db.select({ must: users.mustChangePassword }).from(users).where(eq(users.id, userId));
    expect(user?.must).toBe(true);
    expect(await verifyPassword({ hash: before, password: temporaryPassword })).toBe(true);
  });

  it('rejects a weak new password or reusing the current one', async () => {
    const db = await database();
    await db.insert(users).values({ id: 'user_plain_01', name: 'P', email: 'p@example.test' });
    await db
      .insert(accounts)
      .values({ id: 'acct_plain_01', accountId: 'user_plain_01', providerId: 'credential', userId: 'user_plain_01', password: await hashPassword('old-password-12345') });

    await expect(changePassword(db, { userId: 'user_plain_01', currentPassword: 'old-password-12345', newPassword: 'short' })).rejects.toMatchObject({
      code: 'WEAK_PASSWORD',
    });
    await expect(
      changePassword(db, { userId: 'user_plain_01', currentPassword: 'old-password-12345', newPassword: 'old-password-12345' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await changePassword(db, { userId: 'user_plain_01', currentPassword: 'old-password-12345', newPassword: 'new-password-67890' });
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, 'auth.password.change'));
    expect(entry?.data).toMatchObject({ forced: false });
  });
});
