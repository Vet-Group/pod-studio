import { and, eq, storeMembers, type Database, type GlobalRole } from '@pod-studio/db';
import type { Executor } from '../audit/log';
import {
  ADMIN_STORE_PERMISSIONS,
  isStorePermission,
  isStoreRole,
  sortPermissions,
  type StorePermission,
  type StoreRole,
} from './permissions';

/** The signed-in user performing an action. */
export interface Principal {
  userId: string;
  role: GlobalRole;
}

/** One user's access to one store, as stored in `store_members`. */
export interface StoreMembership {
  role: StoreRole;
  permissions: readonly StorePermission[];
}

export interface StoreScope {
  storeId: string;
}

/**
 * Pure part of {@link can}: what a principal may do in a store given its membership there (or none).
 * A global admin adds {@link ADMIN_STORE_PERMISSIONS} on top of whatever it was granted, never push,
 * publish or settings (ADR 0002).
 */
export function effectivePermissions(principal: Principal, membership: StoreMembership | null): StorePermission[] {
  const held = new Set<StorePermission>(membership?.permissions ?? []);
  if (principal.role === 'admin') for (const permission of ADMIN_STORE_PERMISSIONS) held.add(permission);
  return sortPermissions(held);
}

/**
 * Reads a membership. Rows whose role or permissions are not known values are treated as no access
 * (fail closed) rather than trusted.
 */
export async function findMembership(db: Executor, userId: string, storeId: string): Promise<StoreMembership | null> {
  const [row] = await db
    .select({ role: storeMembers.role, permissions: storeMembers.permissions })
    .from(storeMembers)
    .where(and(eq(storeMembers.storeId, storeId), eq(storeMembers.userId, userId)));
  if (!row || !isStoreRole(row.role)) return null;
  return { role: row.role, permissions: row.permissions.filter(isStorePermission) };
}

/**
 * The single permission check for store-scoped work (ADR 0002 rule 5). Every server action that reads
 * or changes a store calls this, or {@link assertCan}; the UI only mirrors the answer.
 */
export async function can(
  db: Database | Executor,
  principal: Principal,
  permission: StorePermission,
  scope: StoreScope,
): Promise<boolean> {
  if (!principal?.userId || !isStorePermission(permission) || !scope?.storeId) return false;
  const membership = await findMembership(db, principal.userId, scope.storeId);
  return effectivePermissions(principal, membership).includes(permission);
}
