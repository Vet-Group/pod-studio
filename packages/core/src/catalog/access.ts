import { and, eq, productTypes, stores } from '@pod-studio/db';
import { can, type Principal } from '../access';
import { AuthError } from '../auth/errors';
import type { Executor } from '../audit/log';
import { CatalogError } from './validation';

export async function requireCatalog(db: Executor, principal: Principal, storeId: string, edit = false) {
  if (
    !(await can(db, principal, edit ? 'store.settings' : 'store.view', {
      storeId,
    }))
  )
    throw new AuthError(edit ? 'FORBIDDEN' : 'NOT_FOUND');
}
export async function lockCatalog(db: Executor, principal: Principal, storeId: string) {
  // Matches membership-write locking so a permission revocation cannot race a catalog edit.
  const [store] = await db.select({ id: stores.id }).from(stores).where(eq(stores.id, storeId)).for('update');
  if (!store) throw new AuthError('NOT_FOUND');
  await requireCatalog(db, principal, storeId, true);
}
export async function findProductType(db: Executor, storeId: string, typeId: string) {
  const [type] = await db
    .select()
    .from(productTypes)
    .where(and(eq(productTypes.storeId, storeId), eq(productTypes.id, typeId)));
  if (!type) throw new AuthError('NOT_FOUND');
  return type;
}
export function assertRevision(actual: number, revision: number) {
  if (!Number.isInteger(revision) || revision !== actual) throw new CatalogError('CATALOG_CONFLICT');
}
