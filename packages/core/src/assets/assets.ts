import { and, assets, assetUploads, eq, isId, newId, type Database } from '@pod-studio/db';
import { assertCan, type Principal } from '../access';
import { writeAudit } from '../audit/log';
import { AssetError } from './errors';
import { IMAGE_CONTENT_TYPES, MAX_ASSET_BYTES, type Storage } from './storage';

export interface UploadInput { storeId: string; sha256: string; sizeBytes: number; contentType: string }
export async function requestUpload(db: Database, storage: Storage, principal: Principal, input: UploadInput) {
  await assertCan(db, principal, 'design.upload', input.storeId);
  if (!isId(input.storeId) || !/^[a-f0-9]{64}$/.test(input.sha256) || !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > MAX_ASSET_BYTES || !(IMAGE_CONTENT_TYPES as readonly string[]).includes(input.contentType)) throw new AssetError('INVALID_INPUT');
  const uploadId = newId();
  const storageKey = `stores/${input.storeId}/uploads/${uploadId}`;
  const signed = await storage.signUpload(storageKey, input.contentType);
  await db.transaction(async (tx) => {
    await assertCan(tx, principal, 'design.upload', input.storeId);
    await tx.insert(assetUploads).values({ id: uploadId, ...input, storageKey, userId: principal.userId, expiresAt: new Date(signed.expiresAt) });
    await writeAudit(tx, { actorUserId: principal.userId, storeId: input.storeId, action: 'asset.upload.request', targetType: 'asset_upload', targetId: uploadId });
  });
  return { uploadId, ...signed };
}

export async function finalizeUpload(db: Database, storage: Storage, principal: Principal, input: { storeId: string; uploadId: string }) {
  // Candidate keys are unique to this attempt, so compensating a rollback cannot delete a
  // concurrently committed deduplicated asset. S3 and Postgres do not share a transaction.
  let candidateKey: string | undefined;
  const result = await db.transaction(async (tx) => {
    await assertCan(tx, principal, 'design.upload', input.storeId);
    const [upload] = await tx.select().from(assetUploads).where(and(eq(assetUploads.id, input.uploadId), eq(assetUploads.storeId, input.storeId), eq(assetUploads.userId, principal.userId))).for('update');
    if (!upload) throw new AssetError('NOT_FOUND');
    if (upload.status === 'finalized' && upload.assetId) {
      const [asset] = await tx.select().from(assets).where(and(eq(assets.id, upload.assetId), eq(assets.storeId, input.storeId)));
      if (!asset) throw new AssetError('NOT_FOUND');
      return { asset };
    }
    if (upload.status !== 'pending') throw new AssetError('UPLOAD_REJECTED');
    let bytes: Buffer;
    try {
      if (upload.expiresAt.getTime() <= Date.now()) throw new AssetError('UPLOAD_EXPIRED');
      bytes = await storage.readVerified(upload.storageKey, upload);
    } catch (error) {
      if (!(error instanceof AssetError)) throw error;
      await storage.delete(upload.storageKey);
      await tx.update(assetUploads).set({ status: 'rejected' }).where(eq(assetUploads.id, upload.id));
      await writeAudit(tx, { actorUserId: principal.userId, storeId: input.storeId, action: 'asset.reject', targetType: 'asset_upload', targetId: upload.id, data: { reason: error.code } });
      return { error };
    }
    const id = newId();
    const storageKey = `stores/${input.storeId}/assets/${id}`;
    candidateKey = storageKey;
    await storage.putVerified(storageKey, bytes, upload.contentType);
    const [inserted] = await tx.insert(assets).values({ id, storeId: input.storeId, sha256: upload.sha256, storageKey, contentType: upload.contentType, sizeBytes: upload.sizeBytes, createdBy: principal.userId }).onConflictDoNothing({ target: [assets.storeId, assets.sha256] }).returning();
    if (!inserted) await storage.delete(storageKey);
    const [asset] = inserted ? [inserted] : await tx.select().from(assets).where(and(eq(assets.storeId, input.storeId), eq(assets.sha256, upload.sha256)));
    if (!asset) throw new AssetError('NOT_FOUND');
    await storage.delete(upload.storageKey);
    await tx.update(assetUploads).set({ status: 'finalized', assetId: asset.id }).where(eq(assetUploads.id, upload.id));
    await writeAudit(tx, { actorUserId: principal.userId, storeId: input.storeId, action: 'asset.finalize', targetType: 'asset', targetId: asset.id, data: { deduplicated: !inserted } });
    return { asset };
  }).catch(async (error: unknown) => {
    if (candidateKey) {
      try { await storage.delete(candidateKey); } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Finalization and object cleanup failed.');
      }
    }
    throw error;
  });
  if (result.error) throw result.error;
  return result.asset!;
}

/** Raw asset reads are source-store only. Shared assets are read through a checked design grant. */
export async function getAssetUrl(db: Database, storage: Storage, principal: Principal, input: { storeId: string; assetId: string }) {
  await assertCan(db, principal, 'store.view', input.storeId);
  const [asset] = await db.select().from(assets).where(and(eq(assets.id, input.assetId), eq(assets.storeId, input.storeId)));
  if (!asset) throw new AssetError('NOT_FOUND');
  const signed = await storage.signRead(asset.storageKey, asset.contentType);
  await writeAudit(db, { actorUserId: principal.userId, storeId: input.storeId, action: 'asset.read', targetType: 'asset', targetId: asset.id });
  return signed;
}
