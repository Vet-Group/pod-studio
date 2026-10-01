import { createHash } from 'node:crypto';
import { afterEach } from 'vitest';
import { createDatabase, migrateDatabase, storeMembers, stores, users } from '@pod-studio/db';
import { createTestDatabase } from '../../../../tests/support/db';
import { createTestBucket } from '../../../../tests/support/storage';
import { ROLE_PRESETS, type Principal } from '../../src';
import { createStorage } from '../../src/assets/storage';
import { finalizeUpload, requestUpload } from '../../src/assets/assets';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
export const owner: Principal = { userId: 'owner_001', role: 'member' };
export const viewer: Principal = { userId: 'viewer_001', role: 'member' };
export const outsider: Principal = { userId: 'outsider_001', role: 'member' };
export const admin: Principal = { userId: 'admin_001', role: 'admin' };
export const A = 'store_aaa_001';
export const B = 'store_bbb_001';
export const bytes = Buffer.from('image bytes for checksum verification');
export const sha256 = createHash('sha256').update(bytes).digest('hex');
export async function harness(expiresIn = 60) {
  const test = await createTestDatabase();
  cleanup.push(() => test.drop());
  await migrateDatabase(test.connection);
  const handle = createDatabase(test.connection, { max: 5 });
  cleanup.push(() => handle.close());
  const db = handle.db;
  const bucket = await createTestBucket();
  cleanup.push(() => bucket.drop());
  const storage = createStorage({ client: bucket.client, bucket: bucket.name, uploadExpiresIn: expiresIn, readExpiresIn: expiresIn });
  await db.insert(users).values([owner, viewer, outsider, admin].map((p) => ({ id: p.userId, name: p.userId, email: `${p.userId}@example.test`, role: p.role })));
  await db.insert(stores).values([A, B].map((id) => ({ id, name: id, domain: `${id.replaceAll('_', '-')}.myshopify.com` })));
  await db.insert(storeMembers).values([
    ...[A, B].map((storeId) => ({ storeId, userId: owner.userId, role: 'owner', permissions: [...ROLE_PRESETS.owner] })),
    { storeId: A, userId: viewer.userId, role: 'viewer', permissions: [...ROLE_PRESETS.viewer] },
    { storeId: B, userId: outsider.userId, role: 'viewer', permissions: [...ROLE_PRESETS.viewer] },
  ]);
  return { db, bucket, storage };
}
export async function uploaded(h: Awaited<ReturnType<typeof harness>>, storeId = A) {
  const upload = await requestUpload(h.db, h.storage, owner, { storeId, sha256, sizeBytes: bytes.length, contentType: 'image/png' });
  const response = await fetch(upload.url, { method: 'PUT', body: bytes, headers: upload.headers });
  if (!response.ok) throw new Error(`PUT failed: ${response.status}`);
  return { upload, asset: await finalizeUpload(h.db, h.storage, owner, { storeId, uploadId: upload.uploadId }) };
}
