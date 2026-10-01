'use server';

import { revalidatePath } from 'next/cache';
import {
  AuthError,
  CatalogError,
  createProductType,
  updateProductType,
  savePriceTable,
  listCatalog,
  formatPrice,
  isAuthError,
  type Principal,
  type ProductTypeInput,
  type PriceTableInput,
} from '@pod-studio/core';
import { getDatabase } from '@/lib/auth';
import { principalOf } from '@/lib/principal';
import { getCurrentSession } from '@/lib/session';
import type { ProductTypeView } from './types';

async function run(storeId: string, write: (principal: Principal) => Promise<unknown>) {
  try {
    const session = await getCurrentSession();
    if (!session || session.user.mustChangePassword) throw new AuthError('FORBIDDEN');
    if (typeof storeId !== 'string') throw new AuthError('INVALID_INPUT');
    const principal = principalOf(session.user);
    await write(principal);
    const catalog = await listCatalog(getDatabase(), principal, storeId);
    const types: ProductTypeView[] = catalog.types.map((type) => ({
      id: type.id,
      name: type.name,
      currency: type.currency,
      options: type.options,
      revision: type.revision,
      rows: type.rows.map((row) => ({
        id: row.id,
        optionValues: row.optionValues,
        price: formatPrice(row.priceMinor),
        excludedMarkets: row.excludedMarkets,
      })),
    }));
    revalidatePath(`/stores/${storeId}/catalog`);
    return { ok: true as const, data: types };
  } catch (error) {
    if (error instanceof CatalogError) return { ok: false as const, error: error.message, issues: error.issues };
    if (isAuthError(error)) return { ok: false as const, error: error.message, issues: [] };
    throw error;
  }
}
export async function createTypeAction(storeId: string, input: ProductTypeInput) {
  return run(storeId, (principal) => createProductType(getDatabase(), principal, storeId, input));
}
export async function updateTypeAction(
  storeId: string,
  typeId: string,
  input: ProductTypeInput & { revision: number },
) {
  return run(storeId, (principal) => updateProductType(getDatabase(), principal, storeId, typeId, input));
}
export async function savePricesAction(storeId: string, typeId: string, input: PriceTableInput) {
  return run(storeId, (principal) => savePriceTable(getDatabase(), principal, storeId, typeId, input));
}
