'use server';

import { revalidatePath } from 'next/cache';
import { AuthError, saveShopifyConnection, rotateShopifyConnection, removeShopifyConnection, testShopifyConnection, type ShopifyCredentials } from '@pod-studio/core';
import { getDatabase } from '@/lib/auth';
import { getCurrentSession } from '@/lib/session';
import { principalOf } from '@/lib/principal';

async function currentPrincipal() {
  const session = await getCurrentSession();
  if (!session || session.user.mustChangePassword) throw new AuthError('FORBIDDEN');
  return principalOf(session.user);
}
type Result = { ok: true } | { ok: false; error: string };
function safeError(error: unknown): Result {
  if (error instanceof AuthError && ['FORBIDDEN', 'NOT_FOUND', 'INVALID_INPUT'].includes(error.code)) return { ok: false, error: error.message };
  return { ok: false, error: 'Unable to update the Shopify connection. Check the server configuration and try again.' };
}
export async function saveCredentialsAction(storeId: string, input: ShopifyCredentials): Promise<Result> {
  try {
    await saveShopifyConnection(getDatabase(), await currentPrincipal(), storeId, input);
    revalidatePath(`/stores/${storeId}/settings`);
    return { ok: true };
  } catch (error) { return safeError(error); }
}
export async function connectionAction(storeId: string, operation: 'test' | 'rotate' | 'remove'): Promise<Result> {
  try {
    const actor = await currentPrincipal();
    const db = getDatabase();
    if (operation === 'test') await testShopifyConnection(db, actor, storeId);
    else if (operation === 'rotate') await rotateShopifyConnection(db, actor, storeId);
    else if (operation === 'remove') await removeShopifyConnection(db, actor, storeId);
    else throw new AuthError('INVALID_INPUT');
    revalidatePath(`/stores/${storeId}/settings`);
    return { ok: true };
  } catch (error) { return safeError(error); }
}
