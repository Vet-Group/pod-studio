'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  AuthError,
  ROLE_PRESETS,
  createStore,
  createStoreAccess,
  inviteToStore,
  isAuthError,
  isStorePermission,
  isStoreRole,
  removeMember,
  revokeInvite,
  setMemberPermission,
  transferOwnership,
  updateMember,
  type Principal,
} from '@pod-studio/core';
import { getDatabase } from '@/lib/auth';
import { principalOf } from '@/lib/principal';
import { getCurrentSession } from '@/lib/session';

/**
 * Server actions behind the Stores & members screens. Every rule lives in @pod-studio/core; these
 * only resolve the signed-in principal, check argument shapes (they arrive from the client) and turn
 * expected AuthErrors into messages. Anything else is a bug and is rethrown.
 */

export type ActionResult<T = null> = { ok: true; data: T } | { ok: false; error: string };

export type InviteOutcome =
  | { kind: 'added'; email: string }
  | { kind: 'invited'; email: string; path: string; expiresAt: string };

async function currentPrincipal(): Promise<Principal> {
  const session = await getCurrentSession();
  if (!session || session.user.mustChangePassword) throw new AuthError('FORBIDDEN');
  return principalOf(session.user);
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new AuthError('INVALID_INPUT');
  return value;
}

async function run<T>(storeId: unknown, write: (principal: Principal) => Promise<T>): Promise<ActionResult<T>> {
  let data: T;
  try {
    data = await write(await currentPrincipal());
  } catch (error) {
    if (isAuthError(error)) return { ok: false, error: error.message };
    throw error;
  }
  revalidatePath('/stores');
  if (typeof storeId === 'string') revalidatePath(`/stores/${storeId}/members`);
  return { ok: true, data };
}

export async function createStoreAction(input: {
  name: string;
  domain: string;
  ownerUserId: string;
}): Promise<ActionResult<{ storeId: string }>> {
  return run(null, (principal) =>
    createStore(getDatabase(), principal, {
      name: text(input?.name),
      domain: text(input?.domain),
      ownerUserId: text(input?.ownerUserId),
    }),
  );
}

export async function inviteMemberAction(
  storeId: string,
  input: { email: string; role: string; permissions: string[] },
): Promise<ActionResult<InviteOutcome>> {
  return run(storeId, async (principal): Promise<InviteOutcome> => {
    const { role, permissions } = input ?? {};
    if (!isStoreRole(role) || !Array.isArray(permissions) || !permissions.every(isStorePermission)) {
      throw new AuthError('INVALID_INPUT');
    }
    const db = getDatabase();
    const result = await inviteToStore({ db, storeAccess: createStoreAccess(db) }, principal, text(storeId), {
      email: text(input.email),
      role,
      permissions,
    });
    if (result.kind === 'added') return { kind: 'added', email: result.email };
    // The plain token goes back to the inviter once, as a same-site path; it is never logged.
    return {
      kind: 'invited',
      email: result.invite.email,
      path: `/invite/${result.invite.token}`,
      expiresAt: result.invite.expiresAt.toISOString(),
    };
  });
}

/** Changes a member's role and resets their permissions to the role's preset (ADR 0002). */
export async function setRoleAction(storeId: string, userId: string, role: string): Promise<ActionResult> {
  return run(storeId, async (principal) => {
    if (!isStoreRole(role)) throw new AuthError('INVALID_INPUT');
    await updateMember(getDatabase(), principal, text(storeId), text(userId), {
      role,
      permissions: [...ROLE_PRESETS[role]],
    });
    return null;
  });
}

export async function setPermissionAction(
  storeId: string,
  userId: string,
  permission: string,
  enabled: boolean,
): Promise<ActionResult> {
  return run(storeId, async (principal) => {
    if (!isStorePermission(permission) || typeof enabled !== 'boolean') throw new AuthError('INVALID_INPUT');
    await setMemberPermission(getDatabase(), principal, text(storeId), text(userId), permission, enabled);
    return null;
  });
}

export async function transferOwnershipAction(storeId: string, userId: string): Promise<ActionResult> {
  return run(storeId, async (principal) => {
    await transferOwnership(getDatabase(), principal, text(storeId), text(userId));
    return null;
  });
}

/** Removes a member. Leaving a store yourself ends on the store list, which you can still see. */
export async function removeMemberAction(storeId: string, userId: string): Promise<ActionResult> {
  const result = await run(storeId, async (principal) => {
    await removeMember(getDatabase(), principal, text(storeId), text(userId));
    return principal.userId === userId;
  });
  if (!result.ok) return result;
  if (result.data) redirect('/stores');
  return { ok: true, data: null };
}

export async function revokeInviteAction(storeId: string, inviteId: string): Promise<ActionResult> {
  return run(storeId, async (principal) => {
    const db = getDatabase();
    await revokeInvite({ db, storeAccess: createStoreAccess(db) }, principal, text(inviteId));
    return null;
  });
}
