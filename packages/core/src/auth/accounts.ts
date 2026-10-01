import { verifyPassword } from 'better-auth/crypto';
import { accounts, and, eq, ne, newId, sessions, sql, users, type Database, type GlobalRole } from '@pod-studio/db';
import { writeAudit, type Transaction } from '../audit/log';
import { AuthError } from './errors';
import type { Principal } from '../access/can';
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
  return insertTemporaryAccount(db, actor.userId, input);
}

/**
 * Creates the first admin of a fresh install, the only account nobody can invite. Refuses once any
 * admin exists, so it cannot be used to mint a second admin later. Run through `pnpm auth:create-admin`.
 */
export async function createFirstAdmin(
  db: Database,
  input: Omit<CreateUserInput, 'globalRole'>,
): Promise<{ userId: string; email: string; temporaryPassword: string }> {
  return insertTemporaryAccount(db, null, { ...input, globalRole: 'admin' }, async (tx) => {
    // Serialises concurrent bootstrap runs; the second one then sees the first admin and stops.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('pod-studio:first-admin'))`);
    if ((await tx.$count(users, eq(users.role, 'admin'))) > 0) {
      throw new AuthError('FORBIDDEN', 'An admin already exists; ask them for an account instead.');
    }
  });
}

async function insertTemporaryAccount(
  db: Database,
  actorUserId: string | null,
  input: CreateUserInput,
  precheck?: (tx: Transaction) => Promise<void>,
): Promise<{ userId: string; email: string; temporaryPassword: string }> {
  const email = normalizeEmail(input.email);
  const name = normalizeName(input.name);
  const globalRole = input.globalRole ?? 'member';
  if (globalRole !== 'member' && globalRole !== 'admin') throw new AuthError('INVALID_INPUT');

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  const userId = newId();

  await db.transaction(async (tx) => {
    await precheck?.(tx);
    if ((await tx.$count(users, eq(users.email, email))) > 0) throw new AuthError('ACCOUNT_EXISTS');
    await tx
      .insert(users)
      .values({ id: userId, name, email, emailVerified: true, role: globalRole, mustChangePassword: true });
    await tx.insert(accounts).values({ id: newId(), accountId: userId, providerId: 'credential', userId, password: passwordHash });
    await writeAudit(tx, {
      actorUserId,
      action: actorUserId ? 'user.create' : 'user.bootstrap-admin',
      targetType: 'user',
      targetId: userId,
      data: { email, globalRole, temporaryPassword: true },
    });
  });

  return { userId, email, temporaryPassword };
}

const SAME_PASSWORD = 'The new password must differ from the current one.';
const WRONG_PASSWORD = 'The current password is incorrect.';

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
  if (input.newPassword === input.currentPassword) throw new AuthError('INVALID_INPUT', SAME_PASSWORD);
  if (typeof input.currentPassword !== 'string') throw new AuthError('INVALID_INPUT', WRONG_PASSWORD);
  const passwordHash = await hashPassword(input.newPassword);

  await db.transaction(async (tx) => {
    // Verify against the locked row: two requests holding the same old password queue here, and the
    // second one sees the first one's new hash, so it fails instead of overwriting it.
    const [account] = await tx
      .select({ id: accounts.id, password: accounts.password })
      .from(accounts)
      .where(and(eq(accounts.userId, input.userId), eq(accounts.providerId, 'credential')))
      .for('update');
    if (!account?.password || !(await verifyPassword({ hash: account.password, password: input.currentPassword }))) {
      throw new AuthError('INVALID_INPUT', WRONG_PASSWORD);
    }
    // The hash normalises to NFKC, so a look-alike string (e.g. full-width letters) can still be the
    // same password. Compare through the hash, not the raw strings.
    if (await verifyPassword({ hash: account.password, password: input.newPassword })) {
      throw new AuthError('INVALID_INPUT', SAME_PASSWORD);
    }

    const [user] = await tx
      .select({ mustChangePassword: users.mustChangePassword })
      .from(users)
      .where(eq(users.id, input.userId))
      .for('update');
    await tx.update(accounts).set({ password: passwordHash, updatedAt: new Date() }).where(eq(accounts.id, account.id));
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
