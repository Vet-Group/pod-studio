import { accounts, and, eq, gt, invites, isNull, newId, sql, users, type Database, type GlobalRole } from '@pod-studio/db';
import { writeAudit, type Transaction } from '../audit/log';
import { AuthError } from './errors';
import { isStorePermission, isStoreRole, type StorePermission, type StoreRole } from './roles';
import {
  assertPassword,
  generateInviteToken,
  hashInviteToken,
  hashPassword,
  normalizeEmail,
  normalizeName,
} from './secrets';

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The signed-in user performing an action. */
export interface Principal {
  userId: string;
  role: GlobalRole;
}

export interface StoreMembership {
  role: StoreRole;
  permissions: readonly StorePermission[];
}

export interface StoreGrant {
  storeId: string;
  userId: string;
  role: StoreRole;
  permissions: StorePermission[];
}

/**
 * Store membership lookups and writes. store_members arrives in P1-04; until then no implementation
 * exists and invites cannot carry store access (they fail with NOT_SUPPORTED instead of silently
 * dropping the grant).
 */
export interface StoreAccess {
  membership(userId: string, storeId: string): Promise<StoreMembership | null>;
  grant(tx: Transaction, grant: StoreGrant): Promise<void>;
}

export interface InviteDeps {
  db: Database;
  storeAccess?: StoreAccess;
  now?: () => Date;
}

export interface CreateInviteInput {
  email: string;
  globalRole?: GlobalRole;
  store?: { storeId: string; role: StoreRole; permissions: StorePermission[] };
}

export interface CreatedInvite {
  id: string;
  /** Plain token: return it to the inviter once, never log or store it. */
  token: string;
  email: string;
  expiresAt: Date;
}

export type InviteStatus = 'valid' | 'not_found' | 'expired' | 'used' | 'revoked';

const clock = (deps: InviteDeps) => (deps.now ?? (() => new Date()))();

async function assertCanGrantStore(deps: InviteDeps, actor: Principal, store: NonNullable<CreateInviteInput['store']>) {
  if (!deps.storeAccess) throw new AuthError('NOT_SUPPORTED', 'Store invites become available once store permissions ship.');
  if (!isStoreRole(store.role) || !store.permissions.every(isStorePermission)) throw new AuthError('INVALID_INPUT');
  // There is exactly one owner per store; ownership moves through the transfer flow, never an invite.
  if (store.role === 'owner') throw new AuthError('FORBIDDEN', 'An invite cannot grant ownership; transfer ownership instead.');

  const membership = await deps.storeAccess.membership(actor.userId, store.storeId);
  if (store.permissions.includes('product.publish') && membership?.role !== 'owner') {
    throw new AuthError('FORBIDDEN', 'Only the store owner can grant the publish permission.');
  }
  if (actor.role === 'admin') return;
  if (!membership?.permissions.includes('store.members')) throw new AuthError('FORBIDDEN');
  if (!store.permissions.every((p) => membership.permissions.includes(p))) {
    throw new AuthError('FORBIDDEN', 'You cannot grant a permission you do not have.');
  }
}

/**
 * Creates a single-use invite (ADR 0002). Admins invite at any scope; store members holding
 * `store.members` invite only into their own store and never with more permissions than they hold.
 */
export async function createInvite(deps: InviteDeps, actor: Principal, input: CreateInviteInput): Promise<CreatedInvite> {
  const email = normalizeEmail(input.email);
  const globalRole = input.globalRole ?? 'member';
  if (globalRole !== 'member' && globalRole !== 'admin') throw new AuthError('INVALID_INPUT');
  if (globalRole === 'admin' && actor.role !== 'admin') throw new AuthError('FORBIDDEN');

  const store = input.store
    ? { ...input.store, permissions: [...new Set(input.store.permissions)] }
    : undefined;
  if (store) {
    await assertCanGrantStore(deps, actor, store);
  } else if (actor.role !== 'admin') {
    throw new AuthError('FORBIDDEN');
  }

  const [self] = await deps.db.select({ email: users.email }).from(users).where(eq(users.id, actor.userId));
  if (!self || self.email === email) throw new AuthError('FORBIDDEN', 'You cannot invite yourself.');

  const existing = await deps.db.$count(users, eq(users.email, email));
  // Existing accounts join a store by signing in and accepting; that flow ships with store memberships.
  if (existing > 0) throw new AuthError('ACCOUNT_EXISTS');

  const now = clock(deps);
  const token = generateInviteToken();
  const invite = {
    id: newId(),
    email,
    tokenHash: hashInviteToken(token),
    globalRole,
    storeId: store?.storeId ?? null,
    storeRole: store?.role ?? null,
    permissions: store?.permissions ?? [],
    invitedBy: actor.userId,
    expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
    createdAt: now,
  };

  await deps.db.transaction(async (tx) => {
    await tx.insert(invites).values(invite);
    await writeAudit(tx, {
      actorUserId: actor.userId,
      action: 'invite.create',
      targetType: 'invite',
      targetId: invite.id,
      storeId: invite.storeId,
      data: { email, globalRole, storeRole: invite.storeRole, permissions: invite.permissions },
    });
  });

  return { id: invite.id, token, email, expiresAt: invite.expiresAt };
}

function statusOf(row: typeof invites.$inferSelect, now: Date): InviteStatus {
  if (row.revokedAt) return 'revoked';
  if (row.acceptedAt) return 'used';
  if (row.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'valid';
}

const STATUS_ERRORS = {
  not_found: 'INVITE_NOT_FOUND',
  expired: 'INVITE_EXPIRED',
  used: 'INVITE_USED',
  revoked: 'INVITE_REVOKED',
} as const;

/** Looks an invite up by its plain token (for the accept page). */
export async function findInvite(
  db: Database,
  token: string,
  now: Date = new Date(),
): Promise<{ status: 'valid'; email: string; expiresAt: Date } | { status: Exclude<InviteStatus, 'valid'> }> {
  if (typeof token !== 'string' || !token) return { status: 'not_found' };
  const [row] = await db.select().from(invites).where(eq(invites.tokenHash, hashInviteToken(token)));
  if (!row) return { status: 'not_found' };
  const status = statusOf(row, now);
  return status === 'valid' ? { status, email: row.email, expiresAt: row.expiresAt } : { status };
}

export interface AcceptInviteInput {
  token: string;
  name: string;
  password: string;
}

/**
 * Accepts an invite for an email that has no account yet: creates the user and credential account,
 * marks the invite used and grants its store access, all in one transaction. The conditional update
 * on `accepted_at is null` makes concurrent accepts race-safe: exactly one wins.
 */
export async function acceptInvite(deps: InviteDeps, input: AcceptInviteInput): Promise<{ userId: string; email: string }> {
  const name = normalizeName(input.name);
  assertPassword(input.password);
  const passwordHash = await hashPassword(input.password);
  const tokenHash = hashInviteToken(typeof input.token === 'string' ? input.token : '');
  const now = clock(deps);

  return deps.db.transaction(async (tx) => {
    const [row] = await tx.select().from(invites).where(eq(invites.tokenHash, tokenHash)).for('update');
    if (!row) throw new AuthError('INVITE_NOT_FOUND');
    const status = statusOf(row, now);
    if (status !== 'valid') throw new AuthError(STATUS_ERRORS[status]);
    if (row.storeId && !deps.storeAccess) throw new AuthError('NOT_SUPPORTED');

    if ((await tx.$count(users, eq(users.email, row.email))) > 0) throw new AuthError('ACCOUNT_EXISTS');

    // The row lock above serializes concurrent accepts; a waiting transaction re-reads the row after
    // the winner commits and fails the status check. The guarded update is a second line of defence.
    const userId = newId();
    await tx.insert(users).values({ id: userId, name, email: row.email, emailVerified: true, role: row.globalRole });
    await tx.insert(accounts).values({
      id: newId(),
      accountId: userId,
      providerId: 'credential',
      userId,
      password: passwordHash,
    });
    const [claimed] = await tx
      .update(invites)
      .set({ acceptedAt: now, acceptedBy: userId })
      .where(and(eq(invites.id, row.id), isNull(invites.acceptedAt), isNull(invites.revokedAt), gt(invites.expiresAt, now)))
      .returning({ id: invites.id });
    if (!claimed) throw new AuthError('INVITE_USED');

    if (row.storeId && row.storeRole) {
      if (!isStoreRole(row.storeRole) || !row.permissions.every(isStorePermission)) throw new AuthError('INVALID_INPUT');
      await deps.storeAccess!.grant(tx, {
        storeId: row.storeId,
        userId,
        role: row.storeRole,
        permissions: row.permissions as StorePermission[],
      });
    }

    await writeAudit(tx, {
      actorUserId: userId,
      action: 'invite.accept',
      targetType: 'invite',
      targetId: row.id,
      storeId: row.storeId,
      data: { email: row.email, globalRole: row.globalRole, storeRole: row.storeRole, permissions: row.permissions },
    });
    return { userId, email: row.email };
  });
}

/** Revokes a pending invite. Allowed for its inviter, admins, and members managing the invite's store. */
export async function revokeInvite(deps: InviteDeps, actor: Principal, inviteId: string): Promise<void> {
  const now = clock(deps);
  await deps.db.transaction(async (tx) => {
    const [row] = await tx.select().from(invites).where(eq(invites.id, inviteId)).for('update');
    if (!row) throw new AuthError('INVITE_NOT_FOUND');

    let allowed = actor.role === 'admin' || row.invitedBy === actor.userId;
    if (!allowed && row.storeId && deps.storeAccess) {
      const membership = await deps.storeAccess.membership(actor.userId, row.storeId);
      allowed = membership?.permissions.includes('store.members') ?? false;
    }
    if (!allowed) throw new AuthError('FORBIDDEN');

    const status = statusOf(row, now);
    if (status === 'used' || status === 'revoked') throw new AuthError(STATUS_ERRORS[status]);

    await tx.update(invites).set({ revokedAt: now, revokedBy: actor.userId }).where(eq(invites.id, row.id));
    await writeAudit(tx, {
      actorUserId: actor.userId,
      action: 'invite.revoke',
      targetType: 'invite',
      targetId: row.id,
      storeId: row.storeId,
      data: { email: row.email, expired: status === 'expired' },
    });
  });
}

/** Counts invites still usable; used by admin screens and tests. */
export async function countPendingInvites(db: Database, now: Date = new Date()): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(invites)
    .where(and(isNull(invites.acceptedAt), isNull(invites.revokedAt), gt(invites.expiresAt, now)));
  return row?.n ?? 0;
}
