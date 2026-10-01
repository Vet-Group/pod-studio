import { createHash } from 'node:crypto';
import { expect, request, test } from '@playwright/test';
import { seedActiveAccount, seedStore } from './fixtures';

// Backend-first P1-05 uses the public HTTP API and real presigned MinIO requests.
test('direct upload, finalize, scoped reads, sharing and checksum rejection', async ({ baseURL }) => {
  const admin = { userId: process.env.POD_E2E_ADMIN_ID!, role: 'admin' as const };
  const owner = await seedActiveAccount(admin, 'Asset owner');
  const outsider = await seedActiveAccount(admin, 'Asset outsider');
  const a = await seedStore(admin, 'Asset source', owner.userId);
  const b = await seedStore(admin, 'Asset target', owner.userId);
  const c = await seedStore(admin, 'Other store', outsider.userId);
  const api = await request.newContext({ baseURL, extraHTTPHeaders: { origin: baseURL! } });
  const other = await request.newContext({ baseURL, extraHTTPHeaders: { origin: baseURL! } });
  try {
    expect((await api.post('/api/auth/sign-in/email', { data: { email: owner.email, password: owner.password } })).ok()).toBe(true);
    expect((await other.post('/api/auth/sign-in/email', { data: { email: outsider.email, password: outsider.password } })).ok()).toBe(true);
    const body = Buffer.from('e2e image bytes');
    const sha256 = createHash('sha256').update(body).digest('hex');
    const upload = async (hash: string) => {
      const response = await api.post('/api/designs', { data: { operation: 'request-upload', storeId: a.storeId, sha256: hash, sizeBytes: body.length, contentType: 'image/png' } });
      expect(response.status(), await response.text()).toBe(200);
      const data = (await response.json()).data;
      expect((await fetch(data.url, { method: 'PUT', body, headers: data.headers })).ok).toBe(true);
      return data.uploadId as string;
    };
    const uploadId = await upload(sha256);
    const finalized = await api.post('/api/designs', { data: { operation: 'finalize-upload', storeId: a.storeId, uploadId } });
    expect(finalized.status()).toBe(200);
    const asset = (await finalized.json()).data;
    const duplicate = await api.post('/api/designs', { data: { operation: 'finalize-upload', storeId: a.storeId, uploadId: await upload(sha256) } });
    expect((await duplicate.json()).data.id).toBe(asset.id);
    const created = await api.post('/api/designs', { data: { operation: 'create', storeId: a.storeId, assetId: asset.id, name: 'Verified design' } });
    expect(created.status()).toBe(200);
    const design = (await created.json()).data;
    expect((await other.get(`/api/designs?storeId=${a.storeId}&assetId=${asset.id}`)).status()).toBe(403);
    expect((await other.get(`/api/designs?storeId=${c.storeId}&assetId=${asset.id}`)).status()).toBe(404);
    expect((await (await api.get(`/api/designs?storeId=${b.storeId}`)).json()).data).toEqual([]);
    expect((await api.post('/api/designs', { data: { operation: 'share', storeId: a.storeId, designId: design.id, targetStoreId: b.storeId } })).status()).toBe(200);
    const readResponse = await api.get(`/api/designs?storeId=${b.storeId}&designId=${design.id}`);
    expect(readResponse.headers()['cache-control']).toBe('private, no-store');
    const read = (await readResponse.json()).data;
    expect(Buffer.from(await (await fetch(read.url)).arrayBuffer())).toEqual(body);
    const rejected = await api.post('/api/designs', { data: { operation: 'finalize-upload', storeId: a.storeId, uploadId: await upload('0'.repeat(64)) } });
    expect(rejected.status()).toBe(400);
    expect((await rejected.json()).code).toBe('CHECKSUM_MISMATCH');
    const crossOrigin = await api.post('/api/designs', { headers: { origin: 'https://untrusted.example' }, data: { operation: 'request-upload', storeId: a.storeId, sha256, sizeBytes: body.length, contentType: 'image/png' } });
    expect(crossOrigin.status()).toBe(403);
  } finally {
    await api.dispose();
    await other.dispose();
  }
});
