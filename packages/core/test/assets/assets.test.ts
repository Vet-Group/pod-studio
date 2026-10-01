import { HeadObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { assets, assetUploads, auditLog, eq, storeMembers } from '@pod-studio/db';
import { ROLE_PRESETS, effectivePermissions } from '../../src';
import { finalizeUpload, getAssetUrl, requestUpload } from '../../src/assets/assets';
import { A, B, admin, bytes, harness, outsider, owner, sha256, uploaded, viewer } from './harness';

describe('verified, store-scoped assets', () => {
  it('matches the documented library permission matrix without implicit admin writes', () => {
    for (const [role, permissions] of Object.entries(ROLE_PRESETS)) {
      expect(permissions.includes('design.upload'), role).toBe(['owner', 'co_leader', 'designer'].includes(role));
      expect(permissions.includes('design.share'), role).toBe(['owner', 'co_leader'].includes(role));
    }
    expect(effectivePermissions(admin, null)).not.toContain('design.upload');
    expect(effectivePermissions(admin, null)).not.toContain('design.share');
  });
  it('rejects the wrong declared sha256 and deletes the object', async () => {
    const h = await harness();
    const upload = await requestUpload(h.db, h.storage, owner, { storeId: A, sha256: '0'.repeat(64), sizeBytes: bytes.length, contentType: 'image/png' });
    expect((await fetch(upload.url, { method: 'PUT', body: bytes, headers: upload.headers })).ok).toBe(true);
    await expect(finalizeUpload(h.db, h.storage, owner, { storeId: A, uploadId: upload.uploadId })).rejects.toMatchObject({ code: 'CHECKSUM_MISMATCH' });
    const key = decodeURIComponent(new URL(upload.url).pathname.split('/').slice(2).join('/'));
    await expect(h.bucket.client.send(new HeadObjectCommand({ Bucket: h.bucket.name, Key: key }))).rejects.toMatchObject({ $metadata: { httpStatusCode: 404 } });
    expect(await h.db.select().from(assets)).toHaveLength(0);
    expect((await h.db.select().from(auditLog)).filter((r) => r.action === 'asset.reject')).toHaveLength(1);
  });

  it('deduplicates repeated and concurrent uploads in one store, not between stores', async () => {
    const h = await harness();
    const results = await Promise.all([uploaded(h), uploaded(h)]);
    const again = await finalizeUpload(h.db, h.storage, owner, { storeId: A, uploadId: results[0]!.upload.uploadId });
    expect(again.id).toBe(results[0]!.asset.id);
    expect(results[0]!.asset.id).toBe(results[1]!.asset.id);
    const other = await uploaded(h, B);
    expect(other.asset.id).not.toBe(again.id);
    expect(await h.db.select().from(assets)).toHaveLength(2);
    expect((await h.bucket.client.send(new ListObjectsV2Command({ Bucket: h.bucket.name }))).Contents).toHaveLength(2);
  });

  it('cannot read another store asset or bypass scope by changing storeId', async () => {
    const h = await harness();
    const { asset } = await uploaded(h);
    await expect(getAssetUrl(h.db, h.storage, outsider, { storeId: A, assetId: asset.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(getAssetUrl(h.db, h.storage, outsider, { storeId: B, assetId: asset.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const read = await getAssetUrl(h.db, h.storage, viewer, { storeId: A, assetId: asset.id });
    expect(Buffer.from(await (await fetch(read.url)).arrayBuffer())).toEqual(bytes);
    expect(new URL(read.url).searchParams.get('X-Amz-Expires')).toBe('60');
    expect(asset).toMatchObject({ storeId: A, sha256 });
  });

  it('presigned PUT and GET expire at the configured time', async () => {
    const h = await harness(3);
    const { asset, upload } = await uploaded(h);
    const read = await getAssetUrl(h.db, h.storage, owner, { storeId: A, assetId: asset.id });
    expect(new URL(upload.url).searchParams.get('X-Amz-Expires')).toBe('3');
    expect(new URL(read.url).searchParams.get('X-Amz-Expires')).toBe('3');
    await new Promise((resolve) => setTimeout(resolve, 4200));
    expect((await fetch(read.url)).status).toBe(403);
    expect((await fetch(upload.url, { method: 'PUT', body: bytes, headers: upload.headers })).status).toBe(403);
  });

  it('requires explicit upload permission including for global admins', async () => {
    const h = await harness();
    for (const principal of [viewer, outsider, admin]) {
      await expect(requestUpload(h.db, h.storage, principal, { storeId: A, sha256, sizeBytes: bytes.length, contentType: 'image/png' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('does not trust caller-owned upload IDs or revoked permissions', async () => {
    const h = await harness();
    const { upload } = await uploaded(h);
    await expect(finalizeUpload(h.db, h.storage, outsider, { storeId: B, uploadId: upload.uploadId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await h.db.update(storeMembers).set({ permissions: ['store.view'] }).where(eq(storeMembers.userId, owner.userId));
    await expect(finalizeUpload(h.db, h.storage, owner, { storeId: A, uploadId: upload.uploadId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('never exposes a mutable upload key as the finalized asset', async () => {
    const h = await harness();
    const { asset, upload } = await uploaded(h);
    expect((await fetch(upload.url, { method: 'PUT', body: Buffer.from('changed'), headers: upload.headers })).ok).toBe(true);
    const read = await getAssetUrl(h.db, h.storage, owner, { storeId: A, assetId: asset.id });
    expect(Buffer.from(await (await fetch(read.url)).arrayBuffer())).toEqual(bytes);
    expect(asset.storageKey).toMatch(new RegExp(`^stores/${A}/assets/`));
  });

  it('compensates an immutable object when finalization rolls back', async () => {
    const h = await harness();
    const upload = await requestUpload(h.db, h.storage, owner, { storeId: A, sha256, sizeBytes: bytes.length, contentType: 'image/png' });
    await fetch(upload.url, { method: 'PUT', body: bytes, headers: upload.headers });
    const failingStorage = { ...h.storage, delete: async (key: string) => {
      if (key.includes('/uploads/')) throw new Error('Storage deletion failed.');
      await h.storage.delete(key);
    } };
    await expect(finalizeUpload(h.db, failingStorage, owner, { storeId: A, uploadId: upload.uploadId })).rejects.toThrow('Storage deletion failed.');
    expect(await h.db.select().from(assets)).toHaveLength(0);
    expect((await h.bucket.client.send(new ListObjectsV2Command({ Bucket: h.bucket.name }))).Contents).toHaveLength(1);
    expect((await h.db.select().from(assetUploads))[0]).toMatchObject({ status: 'pending' });
  });

  it('rejects expired finalization, content type mismatch and missing objects', async () => {
    const h = await harness();
    const declaration = { storeId: A, sha256, sizeBytes: bytes.length, contentType: 'image/png' };
    const missing = await requestUpload(h.db, h.storage, owner, declaration);
    await expect(finalizeUpload(h.db, h.storage, owner, { storeId: A, uploadId: missing.uploadId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const expired = await requestUpload(h.db, h.storage, owner, declaration);
    await fetch(expired.url, { method: 'PUT', body: bytes, headers: expired.headers });
    await h.db.update(assetUploads).set({ expiresAt: new Date(0) }).where(eq(assetUploads.id, expired.uploadId));
    await expect(finalizeUpload(h.db, h.storage, owner, { storeId: A, uploadId: expired.uploadId })).rejects.toMatchObject({ code: 'UPLOAD_EXPIRED' });
    const wrongType = await requestUpload(h.db, h.storage, owner, declaration);
    const key = decodeURIComponent(new URL(wrongType.url).pathname.split('/').slice(2).join('/'));
    await h.bucket.client.send(new PutObjectCommand({ Bucket: h.bucket.name, Key: key, Body: bytes, ContentType: 'text/html' }));
    await expect(finalizeUpload(h.db, h.storage, owner, { storeId: A, uploadId: wrongType.uploadId })).rejects.toMatchObject({ code: 'CONTENT_TYPE_MISMATCH' });
    expect((await h.bucket.client.send(new ListObjectsV2Command({ Bucket: h.bucket.name }))).Contents ?? []).toHaveLength(0);
  });

  it('rejects size and content type mismatches and invalid declarations', async () => {
    const h = await harness();
    await expect(requestUpload(h.db, h.storage, owner, { storeId: A, sha256: 'bad', sizeBytes: 1, contentType: 'image/png' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const upload = await requestUpload(h.db, h.storage, owner, { storeId: A, sha256, sizeBytes: 1, contentType: 'image/png' });
    await fetch(upload.url, { method: 'PUT', body: bytes, headers: upload.headers });
    await expect(finalizeUpload(h.db, h.storage, owner, { storeId: A, uploadId: upload.uploadId })).rejects.toMatchObject({ code: 'SIZE_MISMATCH' });
  });
});
