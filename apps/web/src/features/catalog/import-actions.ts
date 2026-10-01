'use server';

import { after } from 'next/server';
import { revalidatePath } from 'next/cache';
import {
  AuthError,
  isAuthError,
  resyncVariants,
  runShopifyImport,
  ShopifyImportError,
  startShopifyImport,
} from '@pod-studio/core';
import { getDatabase } from '@/lib/auth';
import { getCurrentSession } from '@/lib/session';
import { principalOf } from '@/lib/principal';

async function actor() {
  const session = await getCurrentSession();
  if (!session || session.user.mustChangePassword) throw new AuthError('FORBIDDEN');
  return principalOf(session.user);
}
function failure(error: unknown) {
  if (isAuthError(error) || error instanceof ShopifyImportError) return { ok: false as const, error: error.message };
  return { ok: false as const, error: 'The catalog operation failed. Try again.' };
}
export async function importShopifyAction(storeId: string, typeId: string) {
  try {
    if (typeof storeId !== 'string' || typeof typeId !== 'string') throw new AuthError('INVALID_INPUT');
    const db = getDatabase();
    const run = await startShopifyImport(db, await actor(), storeId, typeId);
    // Next 16 keeps this callback alive after sending the response; the core persists progress/errors.
    after(async () => {
      try {
        await runShopifyImport(db, run.id);
      } catch {
        console.error('Shopify import background task unavailable.');
      }
    });
    return { ok: true as const, runId: run.id };
  } catch (error) {
    return failure(error);
  }
}
export async function resyncVariantsAction(storeId: string, productId: string) {
  try {
    if (typeof storeId !== 'string' || typeof productId !== 'string') throw new AuthError('INVALID_INPUT');
    await resyncVariants(getDatabase(), await actor(), storeId, productId);
    revalidatePath(`/stores/${storeId}/catalog`);
    return { ok: true as const };
  } catch (error) {
    return failure(error);
  }
}
