import {
  and,
  asc,
  count,
  eq,
  inArray,
  newId,
  sql,
  storeMembers,
  stores,
  users,
  type Database,
} from '@pod-studio/db';
import { writeAudit, type Executor, type Transaction } from '../audit/log';
import { AuthError } from '../auth/errors';
import { normalizeEmail, normalizeName } from '../auth/secrets';
import { effectivePermissions, findMembership, type Principal, type StoreMembership } from './can';
import {
  ADMIN_GRANTABLE,
  ROLE_PRESETS,
  STORE_PERMISSIONS,
  STORE_ROLES,
  isStorePermission,
  isStoreRole,
  sortPermissions,
  type StorePermission,
  type StoreRole,
} from './permissions';

/** A membership row to write; used by invite acceptance and by {@link addMember}. */
export interface StoreGrant {
  storeId: string;
  userId: string;
  role: StoreRole;
  permissions: StorePermission[];
}

/**
 * Store membership lookups and writes as invites see them. {@link createStoreAccess} is the real
 * implementation; tests may pass a fake.
 */
export interface StoreAccess {
  membership(userId: string, storeId: string): Promise<StoreMembership | null>;
  grant(tx: Transaction, grant: StoreGrant, grantedBy?: string | null): Promise<void>;
}

/** {@link StoreAccess} backed by `store_members`. */
export function createStoreAccess(db: Database): StoreAccess {
  return {
    membership: (userId, storeId) => findMembership(db, userId, storeId),
    grant: async (tx, grant, grantedBy = null) => {
      await tx.insert(storeMembers).values({
        id: newId(),
        storeId: grant.storeId,
        userId: grant.userId,
        role: grant.role,
        permissions: sortPermissions(grant.permissions),
        grantedBy,
      });
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// Grant rules (ADR 0002)
// ---------------------------------------------------------------------------------------------------

/** What `actor` may hand out in a store: its own permissions, plus everyday access for admins. */
function grantable(actor: Principal, membership: StoreMembership | null): Set<StorePermission> {
  const held = new Set<StorePermission>(membership?.permissions ?? []);
  if (actor.role === 'admin') for (const permission of ADMIN_GRANTABLE) held.add(permission);
  return held;
}

function canManageMembers(actor: Principal, membership: StoreMembership | null): boolean {
  return effectivePermissions(actor, membership).includes('store.members');
}

function validRoleAndPermissions(role: unknown, permissions: unknown): { role: StoreRole; permissions: StorePermission[] } {
  if (!isStoreRole(role) || !Array.isArray(permissions) || !permissions.every(isStorePermission)) {
    throw new AuthError('INVALID_INPUT');
  }
  return { role, permissions: sortPermissions(permissions) };
}

/**
 * Why `actor` may not change a member from `before` to `after` (either may be empty for add or
 * remove), or null when the change is allowed. Rules: nobody grants what they do not hold; only the
 * owner grants publish; members without `store.members` change nobody; the owner role moves only
 * through {@link transferOwnership}. The UI asks the same question through {@link listMembers}.
 */
function changeDenial(
  actor: Principal,
  actorMembership: StoreMembership | null,
  before: readonly StorePermission[],
  after: readonly StorePermission[],
): AuthError | null {
  if (!canManageMembers(actor, actorMembership)) return new AuthError('FORBIDDEN');
  const held = grantable(actor, actorMembership);
  const isOwner = actorMembership?.role === 'owner';
  const added = after.filter((p) => !before.includes(p));
  const removed = before.filter((p) => !after.includes(p));
  if (added.includes('product.publish') && !isOwner) {
    return new AuthError('FORBIDDEN', 'Only the store owner can grant the publish permission.');
  }
  if (!added.every((p) => held.has(p))) {
    return new AuthError('FORBIDDEN', 'You cannot grant a permission you do not have.');
  }
  // Taking a permission away is a grant decision too: only someone above it in the chain of trust
  // (the owner, an admin, or a holder of that permission) may revoke it.
  if (!isOwner && actor.role !== 'admin' && !removed.every((p) => held.has(p))) {
    return new AuthError('FORBIDDEN', 'You cannot revoke a permission you do not have.');
  }
  return null;
}

function assertCanChange(
  actor: Principal,
  actorMembership: StoreMembership | null,
  before: readonly StorePermission[],
  after: readonly StorePermission[],
) {
  const denial = changeDenial(actor, actorMembership, before, after);
  if (denial) throw denial;
}

/**
 * {@link changeDenial} plus the rule for editing an existing row: people below the owner do not
 * change their own access. Shared by {@link updateMember} and the capabilities in {@link listMembers}.
 */
function updateDenial(
  actor: Principal,
  actorMembership: StoreMembership | null,
  targetUserId: string,
  before: readonly StorePermission[],
  after: readonly StorePermission[],
): AuthError | null {
  const denial = changeDenial(actor, actorMembership, before, after);
  if (denial) return denial;
  if (targetUserId === actor.userId && actorMembership?.role !== 'owner' && actor.role !== 'admin') {
    return new AuthError('FORBIDDEN', 'Ask the store owner to change your own access.');
  }
  return null;
}

/** Permissions of a row that `actor` may switch on or off one at a time, mirroring {@link updateMember}. */
function togglablePermissions(
  actor: Principal,
  actorMembership: StoreMembership | null,
  targetUserId: string,
  row: readonly StorePermission[],
): StorePermission[] {
  return STORE_PERMISSIONS.filter((p) => {
    const after = row.includes(p) ? row.filter((q) => q !== p) : [...row, p];
    return updateDenial(actor, actorMembership, targetUserId, row, after) === null;
  });
}

// ---------------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------------

export interface StoreSummary {
  id: string;
  name: string;
  domain: string;
  owner: { userId: string; name: string; email: string } | null;
  memberCount: number;
  /** The viewer's own access in this store. */
  myRole: StoreRole | null;
  myPermissions: StorePermission[];
}

/**
 * Stores the principal may see: every store for an admin, otherwise the stores it is a member of.
 * Ordered by name.
 */
export async function listStores(db: Database, principal: Principal): Promise<StoreSummary[]> {
  const mine = await db
    .select({ storeId: storeMembers.storeId, role: storeMembers.role, permissions: storeMembers.permissions })
    .from(storeMembers)
    .where(eq(storeMembers.userId, principal.userId));
  const own = new Map(
    mine
      .filter((m) => isStoreRole(m.role))
      .map((m) => [m.storeId, { role: m.role as StoreRole, permissions: m.permissions.filter(isStorePermission) }]),
  );

  const visible = principal.role === 'admin' ? undefined : [...own.keys()];
  if (visible && visible.length === 0) return [];

  const rows = await db
    .select({ id: stores.id, name: stores.name, domain: stores.domain, memberCount: count(storeMembers.id) })
    .from(stores)
    .leftJoin(storeMembers, eq(storeMembers.storeId, stores.id))
    .where(visible ? inArray(stores.id, visible) : undefined)
    .groupBy(stores.id)
    .orderBy(asc(stores.name), asc(stores.id));

  const owners = rows.length
    ? await db
        .select({ storeId: storeMembers.storeId, userId: users.id, name: users.name, email: users.email })
        .from(storeMembers)
        .innerJoin(users, eq(users.id, storeMembers.userId))
        .where(and(eq(storeMembers.role, 'owner'), inArray(storeMembers.storeId, rows.map((r) => r.id))))
    : [];
  const ownerOf = new Map(owners.map((o) => [o.storeId, { userId: o.userId, name: o.name, email: o.email }]));

  return rows.map((r) => {
    const membership = own.get(r.id) ?? null;
    const permissions = effectivePermissions(principal, membership);
    return {
      ...r,
      owner: ownerOf.get(r.id) ?? null,
      myRole: membership?.role ?? null,
      myPermissions: permissions,
    };
  });
}

export interface MemberRow {
  userId: string;
  name: string;
  email: string;
  role: StoreRole;
  permissions: StorePermission[];
  /** What the viewer may do to this row; the write functions check again. */
  can: {
    /** Permissions the viewer may switch on or off here, one at a time. */
    toggle: StorePermission[];
    edit: boolean;
    remove: boolean;
    makeOwner: boolean;
  };
}

export interface StoreMembers {
  store: { id: string; name: string; domain: string };
  members: MemberRow[];
  /** The viewer's own access, so the UI can mirror (never replace) the checks in this module. */
  viewer: {
    role: StoreRole | null;
    permissions: StorePermission[];
    isAdmin: boolean;
    /** Holds `store.members`: may invite, edit and remove members. */
    canManage: boolean;
    /** Store roles the viewer may invite with their preset permissions. */
    inviteRoles: StoreRole[];
    /** Permissions the viewer may hand out here (invite form); empty without `store.members`. */
    grantable: StorePermission[];
  };
}

/** Members of one store. Needs `store.view` there. Owner first, then by name. */
export async function listMembers(db: Database, principal: Principal, storeId: string): Promise<StoreMembers> {
  const [store] = await db
    .select({ id: stores.id, name: stores.name, domain: stores.domain })
    .from(stores)
    .where(eq(stores.id, storeId));
  const membership = store ? await findMembership(db, principal.userId, storeId) : null;
  const permissions = effectivePermissions(principal, membership);
  // Same answer for "no such store" and "not yours", so store ids cannot be probed.
  if (!store || !permissions.includes('store.view')) throw new AuthError('NOT_FOUND');

  const rows = await db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      role: storeMembers.role,
      permissions: storeMembers.permissions,
    })
    .from(storeMembers)
    .innerJoin(users, eq(users.id, storeMembers.userId))
    .where(eq(storeMembers.storeId, storeId))
    .orderBy(sql`case when ${storeMembers.role} = 'owner' then 0 else 1 end`, asc(users.name), asc(users.id));

  const canManage = permissions.includes('store.members');
  const canTransfer = membership?.role === 'owner' || principal.role === 'admin';
  const held = grantable(principal, membership);
  const members: MemberRow[] = rows
    .filter((r) => isStoreRole(r.role))
    .map((r) => {
      const role = r.role as StoreRole;
      const granted = sortPermissions(r.permissions.filter(isStorePermission));
      const isOwnerRow = role === 'owner';
      const isSelf = r.userId === principal.userId;
      return {
        userId: r.userId,
        name: r.name,
        email: r.email,
        role,
        permissions: granted,
        can: {
          toggle: isOwnerRow ? [] : togglablePermissions(principal, membership, r.userId, granted),
          edit: !isOwnerRow && updateDenial(principal, membership, r.userId, granted, granted) === null,
          remove: !isOwnerRow && (isSelf || changeDenial(principal, membership, granted, []) === null),
          makeOwner: canTransfer && !isOwnerRow,
        },
      };
    });

  return {
    store,
    members,
    viewer: {
      role: membership?.role ?? null,
      permissions,
      isAdmin: principal.role === 'admin',
      canManage,
      inviteRoles: canManage
        ? STORE_ROLES.filter((r) => r !== 'owner' && ROLE_PRESETS[r].every((p) => held.has(p)))
        : [],
      // Same rules as changeDenial: nothing beyond what the viewer holds, publish only from the owner.
      grantable: canManage
        ? sortPermissions([...held].filter((p) => p !== 'product.publish' || membership?.role === 'owner'))
        : [],
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// Writes. Each one runs in a transaction, locks the rows it reads, and writes one audit_log row.
// ---------------------------------------------------------------------------------------------------

const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export interface CreateStoreInput {
  name: string;
  domain: string;
  /** Account that becomes the store's single owner. */
  ownerUserId: string;
}

/**
 * Registers a store and its owner. Admin-only for now: ADR 0002's global `store.create` permission
 * is an open decision (docs/plan.md, open question 1), so creation fails closed for everyone else.
 */
export async function createStore(db: Database, actor: Principal, input: CreateStoreInput): Promise<{ storeId: string }> {
  if (actor.role !== 'admin') throw new AuthError('FORBIDDEN');
  const name = normalizeName(input.name);
  const domain = typeof input.domain === 'string' ? input.domain.trim().toLowerCase() : '';
  if (!SHOP_DOMAIN.test(domain)) throw new AuthError('INVALID_INPUT', 'Enter the store domain as <shop>.myshopify.com.');
  if (typeof input.ownerUserId !== 'string' || !input.ownerUserId) throw new AuthError('INVALID_INPUT');

  return db.transaction(async (tx) => {
    const [owner] = await tx.select({ id: users.id }).from(users).where(eq(users.id, input.ownerUserId));
    if (!owner) throw new AuthError('NOT_FOUND');
    if ((await tx.$count(stores, sql`lower(${stores.domain}) = ${domain}`)) > 0) throw new AuthError('STORE_EXISTS');

    const storeId = newId();
    await tx.insert(stores).values({ id: storeId, name, domain });
    await tx.insert(storeMembers).values({
      id: newId(),
      storeId,
      userId: owner.id,
      role: 'owner',
      permissions: [...ROLE_PRESETS.owner],
      grantedBy: actor.userId,
    });
    await writeAudit(tx, {
      actorUserId: actor.userId,
      action: 'store.create',
      targetType: 'store',
      targetId: storeId,
      storeId,
      data: { name, domain, ownerUserId: owner.id },
    });
    return { storeId };
  });
}

async function lockMembership(tx: Executor, storeId: string, userId: string) {
  const [row] = await tx
    .select()
    .from(storeMembers)
    .where(and(eq(storeMembers.storeId, storeId), eq(storeMembers.userId, userId)))
    .for('update');
  return row ?? null;
}

async function assertStoreExists(tx: Executor, storeId: string) {
  // Locking the store row serializes membership changes per store (ownership checks included).
  const [store] = await tx.select({ id: stores.id }).from(stores).where(eq(stores.id, storeId)).for('update');
  if (!store) throw new AuthError('NOT_FOUND');
}

export interface AddMemberInput {
  email: string;
  role: StoreRole;
  permissions?: StorePermission[];
}

/**
 * Adds an existing account to a store. New people join through an invite instead
 * ({@link createInvite} with `store`). The owner role is never granted here.
 */
export async function addMember(
  db: Database,
  actor: Principal,
  storeId: string,
  input: AddMemberInput,
): Promise<{ userId: string }> {
  const email = normalizeEmail(input.email);
  const requested = validRoleAndPermissions(input.role, input.permissions ?? ROLE_PRESETS[input.role as StoreRole] ?? null);
  if (requested.role === 'owner') {
    throw new AuthError('FORBIDDEN', 'A store has exactly one owner; transfer ownership instead.');
  }

  return db.transaction(async (tx) => {
    await assertStoreExists(tx, storeId);
    const actorMembership = await findMembership(tx, actor.userId, storeId);
    assertCanChange(actor, actorMembership, [], requested.permissions);

    const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (!user) throw new AuthError('NOT_FOUND', 'No account uses this email. Send an invite instead.');
    if (await lockMembership(tx, storeId, user.id)) throw new AuthError('ALREADY_MEMBER');

    await tx.insert(storeMembers).values({
      id: newId(),
      storeId,
      userId: user.id,
      role: requested.role,
      permissions: requested.permissions,
      grantedBy: actor.userId,
    });
    await writeAudit(tx, {
      actorUserId: actor.userId,
      action: 'store.member.add',
      targetType: 'user',
      targetId: user.id,
      storeId,
      data: { role: requested.role, permissions: requested.permissions },
    });
    return { userId: user.id };
  });
}

export interface UpdateMemberInput {
  role: StoreRole;
  permissions: StorePermission[];
}

/**
 * Changes a member's role and permission toggles. The owner's row cannot be changed here (rule 3:
 * the last owner cannot be demoted), and nobody can be promoted to owner except by transfer.
 */
export async function updateMember(
  db: Database,
  actor: Principal,
  storeId: string,
  userId: string,
  input: UpdateMemberInput,
): Promise<StoreMembership> {
  const next = validRoleAndPermissions(input.role, input.permissions);
  return changeMember(db, actor, storeId, userId, () => next);
}

/**
 * Switches one permission of a member on or off (the checkboxes in the member table). The row is
 * read under the same lock as the write, so two people toggling different permissions at once both
 * land instead of the later one restoring what the earlier one changed.
 */
export async function setMemberPermission(
  db: Database,
  actor: Principal,
  storeId: string,
  userId: string,
  permission: StorePermission,
  enabled: boolean,
): Promise<StoreMembership> {
  if (!isStorePermission(permission) || typeof enabled !== 'boolean') throw new AuthError('INVALID_INPUT');
  return changeMember(db, actor, storeId, userId, (current) => ({
    role: current.role,
    permissions: enabled
      ? [...current.permissions, permission]
      : current.permissions.filter((p) => p !== permission),
  }));
}

/** Locks one member row, lets `decide` compute its next role and permissions, checks and writes it. */
async function changeMember(
  db: Database,
  actor: Principal,
  storeId: string,
  userId: string,
  decide: (current: { role: StoreRole; permissions: StorePermission[] }) => UpdateMemberInput,
): Promise<StoreMembership> {
  return db.transaction(async (tx) => {
    await assertStoreExists(tx, storeId);
    const target = await lockMembership(tx, storeId, userId);
    if (!target) throw new AuthError('NOT_FOUND');
    if (target.role === 'owner') throw new AuthError('LAST_OWNER');
    if (!isStoreRole(target.role)) throw new AuthError('INVALID_INPUT');

    const before = target.permissions.filter(isStorePermission);
    const proposed = decide({ role: target.role, permissions: before });
    const next = validRoleAndPermissions(proposed.role, proposed.permissions);
    if (next.role === 'owner') throw new AuthError('FORBIDDEN', 'A store has exactly one owner; transfer ownership instead.');

    const actorMembership = await findMembership(tx, actor.userId, storeId);
    const denial = updateDenial(actor, actorMembership, userId, before, next.permissions);
    if (denial) throw denial;

    const changed = target.role !== next.role || before.join(',') !== next.permissions.join(',');
    if (!changed) return next;

    await tx
      .update(storeMembers)
      .set({ role: next.role, permissions: next.permissions, grantedBy: actor.userId })
      .where(eq(storeMembers.id, target.id));
    await writeAudit(tx, {
      actorUserId: actor.userId,
      action: 'store.member.update',
      targetType: 'user',
      targetId: userId,
      storeId,
      data: {
        before: { role: target.role, permissions: before },
        after: next,
        added: next.permissions.filter((p) => !before.includes(p)),
        removed: before.filter((p) => !next.permissions.includes(p)),
      },
    });
    return next;
  });
}

/** Removes a member from a store. The owner cannot be removed (rule 3); transfer first. */
export async function removeMember(db: Database, actor: Principal, storeId: string, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await assertStoreExists(tx, storeId);
    const target = await lockMembership(tx, storeId, userId);
    if (!target) throw new AuthError('NOT_FOUND');
    if (target.role === 'owner') throw new AuthError('LAST_OWNER');

    const actorMembership = await findMembership(tx, actor.userId, storeId);
    const before = target.permissions.filter(isStorePermission);
    // Leaving a store yourself is always allowed; removing someone else is a member-management change.
    if (userId !== actor.userId) assertCanChange(actor, actorMembership, before, []);

    await tx.delete(storeMembers).where(eq(storeMembers.id, target.id));
    await writeAudit(tx, {
      actorUserId: actor.userId,
      action: 'store.member.remove',
      targetType: 'user',
      targetId: userId,
      storeId,
      data: { role: target.role, permissions: before, self: userId === actor.userId },
    });
  });
}

/**
 * Hands the store to another existing member (rule 1: only the owner or an admin). The new owner gets
 * the full owner preset; the previous owner stays on as a co-leader with that role's preset.
 */
export async function transferOwnership(
  db: Database,
  actor: Principal,
  storeId: string,
  newOwnerUserId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await assertStoreExists(tx, storeId);
    const [current] = await tx
      .select()
      .from(storeMembers)
      .where(and(eq(storeMembers.storeId, storeId), eq(storeMembers.role, 'owner')))
      .for('update');
    const isOwner = current?.userId === actor.userId;
    if (!isOwner && actor.role !== 'admin') {
      throw new AuthError('FORBIDDEN', 'Only the store owner or an admin can transfer ownership.');
    }
    if (current?.userId === newOwnerUserId) throw new AuthError('INVALID_INPUT', 'This person already owns the store.');

    const next = await lockMembership(tx, storeId, newOwnerUserId);
    if (!next) throw new AuthError('NOT_FOUND', 'The new owner must already be a member of the store.');

    // Demote first: the partial unique index allows only one owner row per store at any moment.
    if (current) {
      await tx
        .update(storeMembers)
        .set({ role: 'co_leader', permissions: [...ROLE_PRESETS.co_leader], grantedBy: actor.userId })
        .where(eq(storeMembers.id, current.id));
    }
    await tx
      .update(storeMembers)
      .set({ role: 'owner', permissions: [...ROLE_PRESETS.owner], grantedBy: actor.userId })
      .where(eq(storeMembers.id, next.id));

    await writeAudit(tx, {
      actorUserId: actor.userId,
      action: 'store.owner.transfer',
      targetType: 'user',
      targetId: newOwnerUserId,
      storeId,
      data: {
        previousOwnerUserId: current?.userId ?? null,
        newOwnerUserId,
        previousOwnerRole: current ? 'co_leader' : null,
        newOwnerPreviousRole: next.role,
      },
    });
  });
}

export interface AccountOption {
  userId: string;
  name: string;
  email: string;
}

/** Accounts an admin can pick as the owner of a new store. Admin-only. */
export async function listAccounts(db: Database, actor: Principal): Promise<AccountOption[]> {
  if (actor.role !== 'admin') throw new AuthError('FORBIDDEN');
  return db
    .select({ userId: users.id, name: users.name, email: users.email })
    .from(users)
    .orderBy(asc(users.name), asc(users.id));
}
