import { and, asc, eq, newId, pricingRules, productTypes, type Database } from '@pod-studio/db';
import type { Principal } from '../access';
import { writeAudit } from '../audit/log';
import { assertRevision, findProductType, lockCatalog, requireCatalog } from './access';
import { invalid, validateRows, type PriceTableInput } from './validation';

export async function savePriceTable(
  db: Database,
  principal: Principal,
  storeId: string,
  typeId: string,
  input: PriceTableInput,
) {
  return db.transaction(async (tx) => {
    await lockCatalog(tx, principal, storeId);
    const type = await findProductType(tx, storeId, typeId);
    assertRevision(type.revision, input?.revision);
    const rows = validateRows(type.options, input.rows);
    const scope = and(eq(pricingRules.storeId, storeId), eq(pricingRules.productTypeId, typeId));
    const before = await tx.select().from(pricingRules).where(scope).orderBy(asc(pricingRules.sortOrder));
    const existing = new Map(before.map((row) => [row.id, row]));
    for (const row of rows)
      if (row.id && !existing.has(row.id)) invalid('id', 'A price row does not belong to this product type.');
    await tx.delete(pricingRules).where(scope);
    const after = rows.length
      ? await tx
          .insert(pricingRules)
          .values(
            rows.map((row) => ({
              ...row,
              id: row.id ?? newId(),
              storeId,
              productTypeId: typeId,
              createdAt: row.id ? existing.get(row.id)!.createdAt : new Date(),
              updatedAt: new Date(),
            })),
          )
          .returning()
      : [];
    const revision = type.revision + 1;
    await tx.update(productTypes).set({ revision, updatedAt: new Date() }).where(eq(productTypes.id, typeId));
    await writeAudit(tx, {
      actorUserId: principal.userId,
      storeId,
      action: 'catalog.pricing.save',
      targetType: 'product_type',
      targetId: typeId,
      data: {
        before: before.map(({ id, optionValues, priceMinor, excludedMarkets, sortOrder }) => ({
          id,
          optionValues,
          priceMinor,
          excludedMarkets,
          sortOrder,
        })),
        after: after.map(({ id, optionValues, priceMinor, excludedMarkets, sortOrder }) => ({
          id,
          optionValues,
          priceMinor,
          excludedMarkets,
          sortOrder,
        })),
      },
    });
    return { revision, rows: after.sort((a, b) => a.sortOrder - b.sortOrder) };
  });
}

/** Snapshot only the configured rows. Downstream product creation must preserve these identities. */
export async function generateVariants(db: Database, principal: Principal, storeId: string, typeId: string) {
  return db.transaction(
    async (tx) => {
      await requireCatalog(tx, principal, storeId);
      const type = await findProductType(tx, storeId, typeId);
      const rows = await tx
        .select()
        .from(pricingRules)
        .where(and(eq(pricingRules.storeId, storeId), eq(pricingRules.productTypeId, typeId)))
        .orderBy(asc(pricingRules.sortOrder), asc(pricingRules.id));
      return rows.map((row) => ({
        priceRowId: row.id,
        optionValues: row.optionValues,
        priceMinor: row.priceMinor,
        currency: type.currency,
        excludedMarkets: row.excludedMarkets,
        sortOrder: row.sortOrder,
      }));
    },
    { isolationLevel: 'repeatable read' },
  );
}
