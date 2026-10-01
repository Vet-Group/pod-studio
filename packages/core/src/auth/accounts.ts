import { verifyPassword } from 'better-auth/crypto';
import { accounts, and, eq, ne, newId, sessions, users, type Database, type GlobalRole } from '@pod-studio/db';
import { writeAudit } from '../audit/log';
import { AuthError } from './errors';
import type { Principal } from './invites';
import { assertPassword, generateTemporaryPassword, hashPassword, normalizeEmail, normalizeName } from './secrets';

export interface CreateUserInput {
  email: string;
  name: string;
  globalRole?: GlobalRole;
}

/**
 * Admin creates an account directly with a temporary password (ADR 0002). The password is returned
 * once for the admin to hand over; the user must replace it at first sign-in.
 */
export async function createUserWithTemporaryPassword(
  db: Database,
  actor: Principal,
  input: CreateUserInput,
): Promise<{ userId: string; email: string; temporaryPassword: string }> {
  if (actor.role !== 'admin') throw new AuthError('FORBIDDEN');
  const email = normalizeEmail(input.email);
  const name = normalizeName(input.name);
  const globalRole = input.globalRole ?? 'member';
  if (globalRole !== 'member' && globalRole !== 'admin') throw new AuthError('INVALID_INPUT');

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  const userId = newId();

  await db.transaction(async (tx) => {
    if ((await tx.$count(users, eq(users.email, email))) > 0) throw new AuthError('ACCOUNT_EXISTS');
    await tx
      .insert(users)
      .values({ id: userId, name, email, emailVerified: true, role: globalRole, mustChangePassword: true });
    await tx.insert(accounts).values({ id: newId(), accountId: userId, providerId: 'credential', userId, password: passwordHash });
    await writeAudit(tx, {
      actorUserId: actor.userId,
      action: 'user.create',
      targetType: 'user',
      targetId: userId,
      data: { email, globalRole, temporaryPassword: true },
    });
  });

  return { userId, email, temporaryPassword };
}

export interface ChangePasswordInput {
  userId: string;
  currentPassword: string;
  newPassword: string;
  /** Session to keep; every other session of the user is signed out. */
  keepSessionId?: string;
}

/**
 * Verifies the current password, stores the new one, clears must_change_password and signs out the
 * user's other sessions. Used for the forced first-sign-in change and for voluntary changes.
 */
export async function changePassword(db: Database, input: ChangePasswordInput): Promise<void> {
  assertPassword(input.newPassword);
  if (input.newPassword === input.currentPassword) {
    throw new AuthError('INVALID_INPUT', 'Mật khẩu mới phải khác mật khẩu hiện tại.');
  }

  const [account] = await db
    .select({ id: accounts.id, password: accounts.password })
    .from(accounts)
    .where(and(eq(accounts.userId, input.userId), eq(accounts.providerId, 'credential')));
  const valid =
    !!account?.password &&
    typeof input.currentPassword === 'string' &&
    (await verifyPassword({ hash: account.password, password: input.currentPassword }));
  if (!valid) throw new AuthError('INVALID_INPUT', 'Mật khẩu hiện tại không đúng.');

  const passwordHash = await hashPassword(input.newPassword);
  await db.transaction(async (tx) => {
    const [user] = await tx
      .select({ mustChangePassword: users.mustChangePassword })
      .from(users)
      .where(eq(users.id, input.userId))
      .for('update');
    await tx.update(accounts).set({ password: passwordHash, updatedAt: new Date() }).where(eq(accounts.id, account!.id));
    await tx.update(users).set({ mustChangePassword: false, updatedAt: new Date() }).where(eq(users.id, input.userId));
    const others = input.keepSessionId
      ? and(eq(sessions.userId, input.userId), ne(sessions.id, input.keepSessionId))
      : eq(sessions.userId, input.userId);
    const revoked = await tx.delete(sessions).where(others).returning({ id: sessions.id });
    await writeAudit(tx, {
      actorUserId: input.userId,
      action: 'auth.password.change',
      targetType: 'user',
      targetId: input.userId,
      data: { forced: user?.mustChangePassword ?? false, revokedSessions: revoked.length },
    });
  });
}
