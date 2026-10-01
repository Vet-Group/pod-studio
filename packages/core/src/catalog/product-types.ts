import { and, asc, eq, pricingRules, productTypes, sql, type Database } from '@pod-studio/db';
import { can, type Principal } from '../access';
import { writeAudit, type Executor } from '../audit/log';
import { assertRevision, findProductType, lockCatalog, requireCatalog } from './access';
import { formatPrice, invalid, validateProductType, validateRows, type ProductTypeInput } from './validation';

async function uniqueName(db: Executor, storeId: string, name: string, exceptId?: string) {
  const [existing] = await db
    .select({ id: productTypes.id })
    .from(productTypes)
    .where(and(eq(productTypes.storeId, storeId), sql`lower(${productTypes.name}) = ${name.toLowerCase()}`));
  if (existing && existing.id !== exceptId)
    invalid('name', 'A product type with this name already exists in this store.');
}
export async function createProductType(db: Database, principal: Principal, storeId: string, input: ProductTypeInput) {
  return db.transaction(async (tx) => {
    await lockCatalog(tx, principal, storeId);
    const data = validateProductType(input);
    await uniqueName(tx, storeId, data.name);
    const [type] = await tx
      .insert(productTypes)
      .values({ ...data, storeId })
      .returning();
    await writeAudit(tx, {
      actorUserId: principal.userId,
      storeId,
      action: 'catalog.type.create',
      targetType: 'product_type',
      targetId: type!.id,
      data: { ...data },
    });
    return type!;
  });
}
export async function updateProductType(
  db: Database,
  principal: Principal,
  storeId: string,
  typeId: string,
  input: ProductTypeInput & { revision: number },
) {
  return db.transaction(async (tx) => {
    await lockCatalog(tx, principal, storeId);
    const current = await findProductType(tx, storeId, typeId);
    assertRevision(current.revision, input?.revision);
    const data = validateProductType(input);
    await uniqueName(tx, storeId, data.name, typeId);
    const rows = await tx
      .select()
      .from(pricingRules)
      .where(and(eq(pricingRules.storeId, storeId), eq(pricingRules.productTypeId, typeId)))
      .orderBy(asc(pricingRules.sortOrder));
    validateRows(
      data.options,
      rows.map((row) => ({ ...row, price: formatPrice(row.priceMinor) })),
    );
    if (rows.length && current.currency !== data.currency)
      invalid('currency', 'Remove price rows before changing currency; prices are not converted.');
    const [type] = await tx
      .update(productTypes)
      .set({ ...data, revision: current.revision + 1, updatedAt: new Date() })
      .where(eq(productTypes.id, typeId))
      .returning();
    await writeAudit(tx, {
      actorUserId: principal.userId,
      storeId,
      action: 'catalog.type.update',
      targetType: 'product_type',
      targetId: typeId,
      data: {
        before: {
          name: current.name,
          options: current.options,
          currency: current.currency,
        },
        after: data,
      },
    });
    return type!;
  });
}
export async function listCatalog(db: Database, principal: Principal, storeId: string) {
  await requireCatalog(db, principal, storeId);
  const types = await db
    .select()
    .from(productTypes)
    .where(eq(productTypes.storeId, storeId))
    .orderBy(asc(productTypes.name));
  const rows = await db
    .select()
    .from(pricingRules)
    .where(eq(pricingRules.storeId, storeId))
    .orderBy(asc(pricingRules.sortOrder), asc(pricingRules.id));
  return {
    canEdit: await can(db, principal, 'store.settings', { storeId }),
    types: types.map((type) => ({
      ...type,
      rows: rows.filter((row) => row.productTypeId === type.id),
    })),
  };
}
