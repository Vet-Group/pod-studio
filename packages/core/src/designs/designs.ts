import { and, assets, designShares, designs, eq, or, type Database } from '@pod-studio/db';
import { assertCan, type Principal } from '../access';
import { writeAudit } from '../audit/log';
import { AssetError } from '../assets/errors';
import type { Storage } from '../assets/storage';

export async function createDesign(db: Database, principal: Principal, input: { storeId: string; assetId: string; name: string }) {
  return db.transaction(async (tx) => {
    await assertCan(tx, principal, 'design.upload', input.storeId);
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 200) throw new AssetError('INVALID_INPUT');
    const [asset] = await tx.select().from(assets).where(and(eq(assets.id, input.assetId), eq(assets.storeId, input.storeId)));
    if (!asset) throw new AssetError('NOT_FOUND');
    const [design] = await tx.insert(designs).values({ ...input, name: input.name.trim(), createdBy: principal.userId }).returning();
    await writeAudit(tx, { actorUserId: principal.userId, storeId: input.storeId, action: 'design.create', targetType: 'design', targetId: design!.id });
    return design!;
  });
}

export async function listDesigns(db: Database, principal: Principal, storeId: string) {
  await assertCan(db, principal, 'store.view', storeId);
  return db.select({ id: designs.id, storeId: designs.storeId, assetId: designs.assetId, name: designs.name, createdAt: designs.createdAt }).from(designs)
    .leftJoin(designShares, and(eq(designShares.designId, designs.id), eq(designShares.storeId, storeId)))
    .where(or(eq(designs.storeId, storeId), eq(designShares.storeId, storeId))).orderBy(designs.createdAt, designs.id);
}

export async function shareDesign(db: Database, principal: Principal, input: { storeId: string; designId: string; targetStoreId: string }) {
  return db.transaction(async (tx) => {
    await assertCan(tx, principal, 'design.share', input.storeId);
    await assertCan(tx, principal, 'design.upload', input.targetStoreId);
    if (input.storeId === input.targetStoreId) throw new AssetError('INVALID_INPUT');
    const [design] = await tx.select().from(designs).where(and(eq(designs.id, input.designId), eq(designs.storeId, input.storeId)));
    if (!design) throw new AssetError('NOT_FOUND');
    const [share] = await tx.insert(designShares).values({ designId: design.id, storeId: input.targetStoreId, sharedBy: principal.userId }).onConflictDoNothing({ target: [designShares.designId, designShares.storeId] }).returning();
    if (share) await writeAudit(tx, { actorUserId: principal.userId, storeId: input.storeId, action: 'design.share', targetType: 'design', targetId: design.id, data: { targetStoreId: input.targetStoreId } });
    return { designId: design.id, targetStoreId: input.targetStoreId };
  });
}

export async function getDesignUrl(db: Database, storage: Storage, principal: Principal, input: { storeId: string; designId: string }) {
  await assertCan(db, principal, 'store.view', input.storeId);
  const [row] = await db.select({ storageKey: assets.storageKey, contentType: assets.contentType }).from(designs)
    .innerJoin(assets, and(eq(assets.id, designs.assetId), eq(assets.storeId, designs.storeId)))
    .leftJoin(designShares, and(eq(designShares.designId, designs.id), eq(designShares.storeId, input.storeId)))
    .where(and(eq(designs.id, input.designId), or(eq(designs.storeId, input.storeId), eq(designShares.storeId, input.storeId))));
  if (!row) throw new AssetError('NOT_FOUND');
  const signed = await storage.signRead(row.storageKey, row.contentType);
  await writeAudit(db, { actorUserId: principal.userId, storeId: input.storeId, action: 'design.read', targetType: 'design', targetId: input.designId });
  return signed;
}
