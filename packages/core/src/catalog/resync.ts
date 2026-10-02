import { asc, eq, and, pricingRules, products, stores, variants, type Database } from '@pod-studio/db';
import { can, findMembership, type Principal } from '../access';
import { AuthError } from '../auth/errors';
import { writeAudit, type Executor } from '../audit/log';

/** Local catalog writes require an explicit membership even for global admins. */
export async function requireProductEdit(db: Executor, principal: Principal, storeId: string) {
  const membership = await findMembership(db, principal.userId, storeId);
  if (!membership?.permissions.includes('product.edit') || !(await can(db, principal, 'product.edit', { storeId })))
    throw new AuthError('FORBIDDEN');
}
export async function lockProductStore(db: Executor, principal: Principal, storeId: string) {
  const [store] = await db.select().from(stores).where(eq(stores.id, storeId)).for('update');
  if (!store) throw new AuthError('NOT_FOUND');
  await requireProductEdit(db, principal, storeId);
  return store;
}
/** Names and values, not JSON insertion order or Shopify variant positions, define identity. */
export function variantOptionKey(options: Record<string, string>) {
  return JSON.stringify(Object.entries(options).sort(([a], [b]) => a.localeCompare(b, 'en')));
}
export async function currentPriceRows(db: Executor, storeId: string, typeId: string) {
  return db
    .select()
    .from(pricingRules)
    .where(and(eq(pricingRules.storeId, storeId), eq(pricingRules.productTypeId, typeId)))
    .orderBy(asc(pricingRules.sortOrder), asc(pricingRules.id));
}
export async function resyncVariants(db: Database, principal: Principal, storeId: string, productId: string) {
  return db.transaction(async (tx) => {
    await lockProductStore(tx, principal, storeId);
    const [product] = await tx
      .select()
      .from(products)
      .where(and(eq(products.id, productId), eq(products.storeId, storeId)))
      .for('update');
    if (!product) throw new AuthError('NOT_FOUND');
    const before = await tx
      .select()
      .from(variants)
      .where(eq(variants.productId, productId))
      .orderBy(asc(variants.position), asc(variants.id));
    const existing = new Map(before.map((v) => [variantOptionKey(v.optionValues), v]));
    const rows = await currentPriceRows(tx, storeId, product.productTypeId);
    // SKU is the design filename shared by all variants; imported products keep NULL.
    const sku = product.sku ?? before.find((v) => v.sku !== null)?.sku ?? null;
    const kept = new Set<string>();
    for (const row of rows) {
      const old = existing.get(variantOptionKey(row.optionValues));
      const values = {
        priceRowId: row.id,
        optionValues: row.optionValues,
        priceMinor: row.priceMinor,
        excludedMarkets: row.excludedMarkets,
        position: row.sortOrder,
        sku,
        updatedAt: new Date(),
      };
      if (old) {
        await tx.update(variants).set(values).where(eq(variants.id, old.id));
        kept.add(old.id);
      } else {
        const [created] = await tx
          .insert(variants)
          .values({ ...values, productId, inventoryQty: 100 })
          .returning();
        kept.add(created!.id);
      }
    }
    for (const old of before) if (!kept.has(old.id)) await tx.delete(variants).where(eq(variants.id, old.id));
    await tx.update(products).set({ sku, updatedAt: new Date() }).where(eq(products.id, productId));
    await writeAudit(tx, {
      actorUserId: principal.userId,
      storeId,
      action: 'catalog.variants.resynced',
      targetType: 'product',
      targetId: productId,
      data: { beforeCount: before.length, afterCount: rows.length },
    });
    return { count: rows.length };
  });
}
